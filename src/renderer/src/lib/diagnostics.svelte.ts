// Diagnostics collected from the embedded Neovim sessions. The bundled config
// raises a `grove_diagnostics` RPC notification (via vim.rpcnotify) on every
// DiagnosticChanged; the main process forwards it as `event:nvim-notify`. This
// store keeps the latest snapshot per session and exposes a merged, sorted view
// for the Diagnostics pane.

export interface Diagnostic {
  path: string
  lnum: number // 0-based line
  col: number // 0-based column
  endLnum?: number
  severity: number // 1=Error, 2=Warn, 3=Info, 4=Hint (vim.diagnostic.severity)
  message: string
  source?: string
}

export const SEVERITY = {
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  HINT: 4
} as const

export interface DiagnosticCounts {
  errors: number
  warnings: number
  info: number
  hints: number
}

class DiagnosticsStore {
  private bySession = $state<Record<string, Diagnostic[]>>({})
  private started = false

  // Wire the IPC subscriptions once, from the app shell on boot.
  start(): void {
    if (this.started) return
    this.started = true
    window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.method !== 'grove_diagnostics') return
      const list = (event.args?.[0] as Diagnostic[]) ?? []
      this.bySession = { ...this.bySession, [event.id]: list }
    })
    window.workbench.on('event:nvim-exit', (payload) => {
      const event = payload as { id: string }
      if (!(event.id in this.bySession)) return
      const next = { ...this.bySession }
      delete next[event.id]
      this.bySession = next
    })
  }

  // Merged across sessions, de-duplicated, sorted by severity then location.
  // Buffers without a name (scratch) are dropped — they can't be opened.
  get all(): Diagnostic[] {
    const seen = new Set<string>()
    const merged: Diagnostic[] = []
    for (const list of Object.values(this.bySession)) {
      for (const diagnostic of list) {
        if (!diagnostic.path) continue
        const key = `${diagnostic.path}:${diagnostic.lnum}:${diagnostic.col}:${diagnostic.severity}:${diagnostic.message}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(diagnostic)
      }
    }
    merged.sort(compareDiagnostics)
    return merged
  }

  get counts(): DiagnosticCounts {
    const counts: DiagnosticCounts = { errors: 0, warnings: 0, info: 0, hints: 0 }
    for (const diagnostic of this.all) {
      if (diagnostic.severity === SEVERITY.ERROR) counts.errors += 1
      else if (diagnostic.severity === SEVERITY.WARN) counts.warnings += 1
      else if (diagnostic.severity === SEVERITY.INFO) counts.info += 1
      else counts.hints += 1
    }
    return counts
  }
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.severity !== b.severity) return a.severity - b.severity
  const path = a.path.localeCompare(b.path)
  if (path !== 0) return path
  return a.lnum - b.lnum
}

export const diagnostics = new DiagnosticsStore()
