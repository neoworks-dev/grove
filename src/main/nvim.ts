// Embedded Neovim backend. Each session is a vendored `nvim --embed` child
// speaking msgpack-rpc over stdio; the renderer's grid view attaches as a UI
// (ext_linegrid) and streams redraw batches over IPC. Mirrors the
// TerminalManager lifecycle so sessions are resized, killed, and cleaned up
// on shutdown.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { NvimRpc, toPlain } from './nvimRpc'
import { nvimBinary, nvimAvailable, nvimEnvOverlay, ensureNvimUserConfig } from './nvimPaths'

export interface NvimEvents {
  onRedraw: (id: string, events: unknown[]) => void
  onExit: (id: string, exitCode: number) => void
  // Custom RPC notifications the config raises via vim.rpcnotify (e.g. diagnostic
  // pushes). Redraw is handled separately; everything else lands here.
  onNotify: (id: string, method: string, args: unknown[]) => void
}

export interface SpawnNvimOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

interface NvimSession {
  child: ChildProcess
  rpc: NvimRpc
  pending: unknown[]
  flushTimer: ReturnType<typeof setTimeout> | null
  // Set when grove kills the session itself; silences the expected
  // "Caught deadly signal" stderr noise.
  killedByUs: boolean
}

// Forward redraw events on nvim's own flush boundaries, with safety valves
// for floods (an embedded :term) and cycles that never flush.
const MAX_PENDING_EVENTS = 8192
const FLUSH_FALLBACK_MS = 16
const KILL_GRACE_MS = 2000

export class NeovimManager {
  private sessions = new Map<string, NvimSession>()
  private counter = 0

  constructor(private events: NvimEvents) {}

  // Spawn the child and wire the RPC, but do NOT attach the UI yet. The
  // renderer subscribes to event:nvim-redraw between spawn and attach, so
  // nvim's first redraw batch (emitted on ui_attach) is never dropped.
  async spawn(options: SpawnNvimOptions): Promise<string> {
    if (!nvimAvailable()) {
      throw new Error('nvim runtime missing — run `bun scripts/fetch-nvim.ts`')
    }
    this.counter += 1
    const id = `nvim-${this.counter}`
    const env = { ...options.env, ...nvimEnvOverlay() }
    await this.ensureStateDirs(env)
    await ensureNvimUserConfig()

    const child = spawn(nvimBinary(), ['--embed'], { cwd: options.cwd, env })
    if (!child.stdin || !child.stdout) throw new Error('nvim spawn failed: no stdio')
    const rpc = new NvimRpc(child.stdin, child.stdout)
    const session: NvimSession = { child, rpc, pending: [], flushTimer: null, killedByUs: false }
    this.sessions.set(id, session)

    child.stderr?.on('data', (chunk: Buffer) => {
      if (session.killedByUs) return
      console.warn(`[nvim ${id}]`, chunk.toString().trimEnd())
    })
    child.on('exit', (code) => {
      this.sessions.delete(id)
      rpc.close()
      this.events.onExit(id, code ?? 0)
    })
    child.on('error', (error) => {
      console.warn(`[nvim ${id}] spawn error:`, error)
      this.sessions.delete(id)
      rpc.close()
      this.events.onExit(id, -1)
    })

    rpc.onNotification((method, args) => {
      if (method === 'redraw') {
        this.queueRedraw(id, session, args)
        return
      }
      this.events.onNotify(id, method, toPlain(args) as unknown[])
    })
    return id
  }

  // Attach the grid UI and open the initial file. Called after the renderer
  // has subscribed to redraw events.
  async attach(id: string, cols: number, rows: number, file?: string): Promise<void> {
    const session = this.requireSession(id)
    await session.rpc.request('nvim_ui_attach', [cols, rows, { rgb: true, ext_linegrid: true }])
    if (file) {
      await session.rpc.request('nvim_cmd', [{ cmd: 'edit', args: [file] }, {}])
    }
  }

  input(id: string, keys: string): void {
    this.sessions.get(id)?.rpc.notify('nvim_input', [keys])
  }

  // Forward a mouse event to nvim. Single-grid UI, so grid is 0.
  inputMouse(
    id: string,
    button: string,
    action: string,
    modifier: string,
    row: number,
    col: number
  ): void {
    this.sessions
      .get(id)
      ?.rpc.notify('nvim_input_mouse', [button, action, modifier, 0, row, col])
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    session?.rpc.notify('nvim_ui_try_resize', [Math.max(1, cols), Math.max(1, rows)])
  }

  async command(id: string, command: string): Promise<void> {
    // A command racing a dying/gone session (rebind, crash-restart, quit) is
    // expected; treat "session gone" as a no-op rather than a handler error.
    const session = this.sessions.get(id)
    if (!session) return
    try {
      await session.rpc.request('nvim_command', [command])
    } catch (error) {
      if (this.isSessionGone(id)) return
      throw error
    }
  }

  async request(id: string, method: string, args: unknown[]): Promise<unknown> {
    if (!/^nvim_/.test(method)) throw new Error(`blocked non-api method: ${method}`)
    const session = this.sessions.get(id)
    // A request racing a dying/gone session is expected by design; the renderer
    // already treats it as "session gone". Return null instead of throwing so
    // Electron doesn't log it as a handler error. Real nvim API errors from a
    // still-live session (session stays in the map) still propagate.
    if (!session) return null
    try {
      return toPlain(await session.rpc.request(method, args))
    } catch (error) {
      if (this.isSessionGone(id)) return null
      throw error
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.killedByUs = true
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.rpc.close()
    session.child.kill('SIGTERM')
    const hardKill = setTimeout(() => {
      if (!session.child.killed || session.child.exitCode === null) {
        session.child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS)
    // Don't keep the app alive just for the grace timer.
    hardKill.unref?.()
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private requireSession(id: string): NvimSession {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`unknown nvim session: ${id}`)
    return session
  }

  // The exit/error handlers delete a session from the map when its nvim dies.
  // So an absent session after an RPC rejection means the child exited mid-flight
  // (a benign teardown race), not a genuine nvim API error.
  private isSessionGone(id: string): boolean {
    return !this.sessions.has(id)
  }

  private queueRedraw(id: string, session: NvimSession, batch: unknown[]): void {
    for (const event of batch) session.pending.push(toPlain(event))
    const last = batch[batch.length - 1]
    const isFlush = Array.isArray(last) && last[0] === 'flush'
    if (isFlush || session.pending.length > MAX_PENDING_EVENTS) {
      this.flushRedraw(id, session)
      return
    }
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => this.flushRedraw(id, session), FLUSH_FALLBACK_MS)
  }

  private flushRedraw(id: string, session: NvimSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.pending.length === 0) return
    const events = session.pending
    session.pending = []
    this.events.onRedraw(id, events)
  }

  private async ensureStateDirs(env: NodeJS.ProcessEnv): Promise<void> {
    for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      const dir = env[key]
      if (dir) await mkdir(dir, { recursive: true })
    }
  }
}
