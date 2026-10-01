// The renderer's view of the debugger. The main process owns every session and
// breakpoint (src/main/debug) and pushes a whole DebugSnapshot on each change;
// this store keeps the latest one, the Debug Console's lines, and the launch
// configurations for the open worktree, and turns the UI's intents into calls.

import type {
  DebugBreakpoint,
  DebugBreakpointOptions,
  DebugConfigurationEntry,
  DebugOutputLine,
  DebugSessionSummary,
  DebugSnapshot,
  DebugThread
} from '../../../../../shared/debug'
import { store, openFileAtLine } from '../../../lib/store.svelte'
import { activeNvimSession, sessionByNvimId } from '../../../lib/nvim/registry'
import { dialogs } from '../../../lib/dialogs.svelte'
import { layout } from '../../../lib/layout.svelte'
import { messageOf } from './messages'

const OUTPUT_LIMIT = 5000

/** Asks debug.lua to report the cursor's line as one to edit the breakpoint of. */
const EDIT_AT_CURSOR_LUA = 'if _G.grove_debug then _G.grove_debug.edit_at_cursor() end'

/** A line whose breakpoint is being edited in the box over an editor. */
export interface BreakpointEditTarget {
  /** The editor pane the box opens in. */
  leafId: string
  path: string
  line: number
  /** Where nvim drew the line, 1-based, for placing the box. */
  screenRow: number
  screenCol: number
}

function emptySnapshot(): DebugSnapshot {
  return {
    breakpoints: [],
    sessions: [],
    focusedSessionId: null,
    focusedFrameId: null,
    focusedLocation: null,
    stopSequence: 0,
    watches: []
  }
}

class DebugStore {
  snapshot = $state<DebugSnapshot>(emptySnapshot())
  output = $state<DebugOutputLine[]>([])
  configurations = $state<DebugConfigurationEntry[]>([])
  selectedConfigurationKey = $state<string | null>(null)
  starting = $state(false)
  installing = $state<string | null>(null)
  /** The line whose breakpoint the editor's box is open for. */
  editing = $state<BreakpointEditTarget | null>(null)
  private revealedStop = 0
  private started = false

  /** Subscribes to the main process's pushes. Returns the inverse. */
  start(): () => void {
    if (this.started) {
      return () => {}
    }
    this.started = true
    const unsubscribeState = window.workbench.on('event:debug-state', (payload) => {
      this.adopt(payload as DebugSnapshot)
    })
    const unsubscribeOutput = window.workbench.on('event:debug-output', (payload) => {
      this.appendOutput(payload as DebugOutputLine)
    })
    const unsubscribeCleared = window.workbench.on('event:debug-output-cleared', () => {
      this.output = []
    })
    const unsubscribeEdit = window.workbench.on('event:nvim-notify', (payload) => {
      this.onNvimNotify(payload as { id: string; method: string; args: unknown[] })
    })
    void this.load()
    return () => {
      unsubscribeState()
      unsubscribeOutput()
      unsubscribeCleared()
      unsubscribeEdit()
      this.started = false
    }
  }

  private async load(): Promise<void> {
    const [snapshot, output] = await Promise.all([
      window.workbench.debugger.snapshot(),
      window.workbench.debugger.output()
    ])
    this.revealedStop = snapshot.stopSequence
    this.snapshot = snapshot
    this.output = output
  }

  /** Takes a new snapshot, revealing the stop it reports if it is a new one. */
  private adopt(snapshot: DebugSnapshot): void {
    this.snapshot = snapshot
    if (snapshot.stopSequence <= this.revealedStop) {
      return
    }
    this.revealedStop = snapshot.stopSequence
    this.revealFocusedLocation()
  }

  private appendOutput(line: DebugOutputLine): void {
    const next = [...this.output, line]
    if (next.length > OUTPUT_LIMIT) {
      next.splice(0, next.length - OUTPUT_LIMIT)
    }
    this.output = next
    if (line.category === 'stderr' || line.category === 'error') {
      layout.ensurePane('debugConsole')
    }
  }

  // ── Derived state ──────────────────────────────────────────────

  get sessions(): DebugSessionSummary[] {
    return this.snapshot.sessions
  }

  get focusedSession(): DebugSessionSummary | null {
    const id = this.snapshot.focusedSessionId
    return this.sessions.find((session) => session.id === id) || null
  }

  /** Whether any session is live. */
  get active(): boolean {
    return this.sessions.some((session) => session.state !== 'terminated')
  }

  get stopped(): boolean {
    return this.focusedSession?.state === 'stopped'
  }

  get selectedConfiguration(): DebugConfigurationEntry | null {
    const key = this.selectedConfigurationKey
    return this.configurations.find((entry) => entry.key === key) || this.configurations[0] || null
  }

  /** The thread the focused frame belongs to. */
  get focusedThread(): DebugThread | null {
    const session = this.focusedSession
    if (!session) {
      return null
    }
    const frameId = this.snapshot.focusedFrameId
    for (const thread of session.threads) {
      if (thread.frames.some((frame) => frame.id === frameId)) {
        return thread
      }
    }
    return session.threads.find((thread) => thread.id === session.stoppedThreadId) || null
  }

  // ── Configurations ─────────────────────────────────────────────

  /** Re-lists the configurations for the selected worktree and the editor's file. */
  async refreshConfigurations(): Promise<void> {
    const editor = await this.editorContext()
    if (!editor) {
      this.configurations = []
      return
    }
    this.configurations = await window.workbench.debugger.configurations(editor)
  }

  /** Starts the selected configuration, installing its adapter first when asked to. */
  async startSelected(): Promise<void> {
    const entry = this.selectedConfiguration
    if (!entry) {
      dialogs.notify({
        level: 'info',
        message:
          'Nothing to debug here: open a file a debug adapter knows, or add .vscode/launch.json'
      })
      return
    }
    await this.startConfiguration(entry)
  }

  async startConfiguration(entry: DebugConfigurationEntry): Promise<void> {
    const editor = await this.editorContext()
    if (!editor || this.starting) {
      return
    }
    this.selectedConfigurationKey = entry.key
    this.starting = true
    try {
      if (!entry.adapterReady && entry.installPackage) {
        await this.install(entry.installPackage)
      }
      layout.ensurePane('debugConsole')
      await window.workbench.debugger.start(editor, $state.snapshot(entry.configuration))
    } catch (error) {
      dialogs.notify({ level: 'error', message: `Could not start debugging: ${messageOf(error)}` })
    } finally {
      this.starting = false
    }
  }

  async install(masonPackage: string): Promise<void> {
    this.installing = masonPackage
    try {
      await window.workbench.debugger.installAdapter(masonPackage)
      await this.refreshConfigurations()
    } finally {
      this.installing = null
    }
  }

  /** The worktree and the editor's file and line, for listing and starting. */
  private async editorContext(): Promise<{
    worktreeId: string
    activeFile?: string
    activeLine?: number
  } | null> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) {
      return null
    }
    const active = await activeNvimSession()?.getActiveFile()
    if (active) {
      return { worktreeId, activeFile: active.path, activeLine: active.line }
    }
    if (store.activeTabPath) {
      return { worktreeId, activeFile: store.activeTabPath }
    }
    return { worktreeId }
  }

  // ── Execution ──────────────────────────────────────────────────

  /** F5: continue a stopped session, or start the selected configuration. */
  async continueOrStart(): Promise<void> {
    if (this.stopped) {
      await this.run(() => window.workbench.debugger.continue())
      return
    }
    if (this.active) {
      return
    }
    await this.refreshConfigurations()
    await this.startSelected()
  }

  continue(): Promise<void> {
    return this.run(() => window.workbench.debugger.continue())
  }

  pause(): Promise<void> {
    return this.run(() => window.workbench.debugger.pause())
  }

  stepOver(): Promise<void> {
    return this.run(() => window.workbench.debugger.stepOver())
  }

  stepInto(): Promise<void> {
    return this.run(() => window.workbench.debugger.stepInto())
  }

  stepOut(): Promise<void> {
    return this.run(() => window.workbench.debugger.stepOut())
  }

  restart(): Promise<void> {
    return this.run(() => window.workbench.debugger.restart())
  }

  stop(): Promise<void> {
    return this.run(() => window.workbench.debugger.stop())
  }

  /** Focuses a frame and shows its line in the editor. */
  async selectFrame(sessionId: string, threadId: number, frameId: number): Promise<void> {
    await window.workbench.debugger.focus(sessionId, threadId, frameId)
    const session = this.sessions.find((candidate) => candidate.id === sessionId)
    const thread = session?.threads.find((candidate) => candidate.id === threadId)
    const frame = thread?.frames.find((candidate) => candidate.id === frameId)
    if (session && frame?.path) {
      this.reveal(session.worktreePath, frame.path, frame.line)
    }
  }

  // ── Breakpoints ────────────────────────────────────────────────

  /** F9: toggles the breakpoint on the editor's cursor line. */
  async toggleBreakpointAtCursor(): Promise<void> {
    const active = await activeNvimSession()?.getActiveFile()
    if (!active) {
      return
    }
    await window.workbench.debugger.toggleBreakpoint(active.path, active.line)
  }

  /** The breakpoint on a line, if there is one. */
  breakpointAt(path: string, line: number): DebugBreakpoint | null {
    const found = this.snapshot.breakpoints.find(
      (breakpoint) => breakpoint.path === path && breakpoint.line === line
    )
    return found || null
  }

  /** Opens the breakpoint editor over the cursor's line in the focused editor. */
  async editBreakpointAtCursor(): Promise<void> {
    const session = activeNvimSession()
    if (!session || !session.id) {
      return
    }
    await window.workbench.nvim
      .request(session.id, 'nvim_exec_lua', [EDIT_AT_CURSOR_LUA, []])
      .catch(() => undefined)
  }

  /** Adds the breakpoint on a line with these options, or changes the one there. */
  async saveBreakpoint(path: string, line: number, options: DebugBreakpointOptions): Promise<void> {
    await this.run(() =>
      window.workbench.debugger.setBreakpoint(path, line, options).then(() => {})
    )
  }

  /** Closes the editor's breakpoint box and gives the editor its keyboard back. */
  closeBreakpointEditor(): void {
    this.editing = null
  }

  /** A right-click in the gutter (or the edit key) arrives from debug.lua as a notification. */
  private onNvimNotify(event: { id: string; method: string; args: unknown[] }): void {
    if (event.method !== 'grove_debug_edit_breakpoint') {
      return
    }
    const target = editTargetOf(event.id, event.args[0])
    if (target) {
      this.editing = target
    }
  }

  // ── Evaluation ─────────────────────────────────────────────────

  /** Evaluates console input; the result arrives as Debug Console output. */
  async evaluateInConsole(expression: string): Promise<void> {
    if (!this.active) {
      dialogs.notify({ level: 'info', message: 'Start debugging to evaluate expressions' })
      return
    }
    await window.workbench.debugger.evaluate(expression, 'repl').catch(() => undefined)
  }

  // ── Internals ──────────────────────────────────────────────────

  private async run(command: () => Promise<void>): Promise<void> {
    try {
      await command()
    } catch (error) {
      dialogs.notify({ level: 'error', message: messageOf(error) })
    }
  }

  private revealFocusedLocation(): void {
    const location = this.snapshot.focusedLocation
    const session = this.focusedSession
    if (!location || !session) {
      return
    }
    this.reveal(session.worktreePath, location.path, location.line)
  }

  /** Opens a file at a line, in the worktree the session runs in. */
  private reveal(worktreePath: string, path: string, line: number): void {
    const worktree = store.worktrees.find((candidate) => candidate.path === worktreePath)
    let worktreeId = store.selectedWorktreeId
    if (worktree) {
      worktreeId = worktree.id
    }
    if (!worktreeId) {
      return
    }
    openFileAtLine(worktreeId, path, line)
  }
}

/** Reads debug.lua's edit request into a target, or null when it names no editor or line. */
function editTargetOf(nvimId: string, payload: unknown): BreakpointEditTarget | null {
  const session = sessionByNvimId(nvimId)
  if (!session || !payload || typeof payload !== 'object') {
    return null
  }
  const request = payload as Record<string, unknown>
  if (typeof request.path !== 'string' || typeof request.line !== 'number') {
    return null
  }
  return {
    leafId: session.leafId,
    path: request.path,
    line: request.line,
    screenRow: positiveOr(request.screenRow, 1),
    screenCol: positiveOr(request.screenCol, 1)
  }
}

/** A positive number as given, else the fallback. */
function positiveOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && value > 0) {
    return value
  }
  return fallback
}

export const debug = new DebugStore()
