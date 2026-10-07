// Runs one worktree's processes. Each process gets its own plugin-owned
// terminal; its output is that terminal's stream, kept raw (colours and all)
// for the page to draw, and its exit code ends it. Dependencies are honoured
// by holding a process back until what it depends on has started or
// finished, as its condition asks.

import * as grove from '@grove/plugin-sdk'
import type { ProcessSpec } from './config'
import { cancellation } from './token'

export type ProcessStatus =
  | 'idle'
  | 'disabled'
  | 'waiting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'skipped'

export interface ProcessState {
  spec: ProcessSpec
  status: ProcessStatus
  exitCode: number | null
  output: OutputBuffer
  terminalId: string | null
  // Ends the output stream of the current run.
  cancel: (() => void) | null
  // Resolved when the current run ends.
  exitWaiters: (() => void)[]
}

export interface RunnerEvents {
  // A process's status changed.
  onChange(): void
  // A process printed something; `data` is raw terminal output.
  onOutput(name: string, data: string): void
  // A process's output started over (a new run).
  onOutputReset(name: string): void
}

// Printed by the wrapper script before the command runs; everything before it
// is the shell's prompt and the echo of what was typed. The script travels
// encoded, so the echo itself never contains it.
const START_MARKER = '__grove_pc_start__'
const STOP_GRACE_MS = 5000
// Output kept per process, for pages that open later.
const MAX_OUTPUT_CHARS = 512 * 1024

/** A process's raw output since it last started, capped from the front. */
export class OutputBuffer {
  private text = ''
  private preamble: string | null = ''

  get value(): string {
    return this.text
  }

  /** Takes a chunk from the terminal; returns the part worth showing. */
  push(data: string): string {
    let shown = data
    if (this.preamble !== null) {
      this.preamble += data
      const at = this.preamble.indexOf(START_MARKER)
      if (at === -1) return ''
      const lineEnd = this.preamble.indexOf('\n', at)
      if (lineEnd === -1) return ''
      shown = this.preamble.slice(lineEnd + 1)
      this.preamble = null
    }
    this.text += shown
    if (this.text.length > MAX_OUTPUT_CHARS) {
      const cut = this.text.indexOf('\n', this.text.length - MAX_OUTPUT_CHARS)
      this.text = this.text.slice(cut === -1 ? this.text.length - MAX_OUTPUT_CHARS : cut + 1)
    }
    return shown
  }

  /** A line from the plugin itself, shown whether or not the command started. */
  note(line: string): string {
    this.preamble = null
    const shown = `\x1b[2m${line}\x1b[0m\r\n`
    this.text += shown
    return shown
  }

  clear(): void {
    this.text = ''
    this.preamble = ''
  }
}

export class ProjectRunner {
  readonly processes = new Map<string, ProcessState>()

  constructor(
    readonly worktreeId: string,
    readonly file: string,
    specs: ProcessSpec[],
    private readonly events: RunnerEvents
  ) {
    for (const spec of specs) {
      this.processes.set(spec.name, {
        spec,
        status: spec.disabled ? 'disabled' : 'idle',
        exitCode: null,
        output: new OutputBuffer(),
        terminalId: null,
        cancel: null,
        exitWaiters: []
      })
    }
  }

  get active(): boolean {
    for (const state of this.processes.values()) {
      if (isLive(state.status)) return true
    }
    return false
  }

  // Starts every enabled process that isn't already live, in dependency order.
  startAll(): void {
    for (const state of this.processes.values()) {
      if (state.spec.disabled || isLive(state.status)) continue
      this.reset(state)
      state.status = 'waiting'
    }
    this.schedule()
    this.events.onChange()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((name) => this.stop(name)))
  }

  async restartAll(): Promise<void> {
    await this.stopAll()
    this.startAll()
  }

  // Started by hand: dependencies are the user's call, not waited on.
  start(name: string): void {
    const state = this.processes.get(name)
    if (!state || isLive(state.status)) return
    this.reset(state)
    void this.launch(state)
  }

  async stop(name: string): Promise<void> {
    const state = this.processes.get(name)
    if (!state) return
    if (state.status === 'waiting') {
      state.status = 'stopped'
      this.events.onChange()
      return
    }
    if (state.status !== 'running' || !state.terminalId) return
    const terminalId = state.terminalId
    state.status = 'stopping'
    this.events.onChange()
    // Ctrl-C reaches the whole foreground group, the command's children too.
    await grove.terminals.write(terminalId, '\x03').catch(() => undefined)
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STOP_GRACE_MS)
      state.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (exited) return
    await grove.terminals.kill(terminalId).catch(() => undefined)
    // A killed terminal's stream never reports an exit; end it here.
    state.cancel?.()
    this.finish(state, terminalId, null)
  }

  async restart(name: string): Promise<void> {
    await this.stop(name)
    this.start(name)
  }

  /** Types into a running process's terminal. */
  write(name: string, data: string): void {
    const terminalId = this.processes.get(name)?.terminalId
    if (terminalId) void grove.terminals.write(terminalId, data).catch(() => undefined)
  }

  resize(name: string, cols: number, rows: number): void {
    const terminalId = this.processes.get(name)?.terminalId
    if (terminalId) void grove.terminals.resize(terminalId, cols, rows).catch(() => undefined)
  }

  private reset(state: ProcessState): void {
    state.output.clear()
    state.exitCode = null
    this.events.onOutputReset(state.spec.name)
  }

  private note(state: ProcessState, line: string): void {
    this.events.onOutput(state.spec.name, state.output.note(line))
  }

  private async launch(state: ProcessState): Promise<void> {
    state.status = 'running'
    this.events.onChange()
    let terminalId: string
    try {
      const created = await grove.terminals.create({
        worktreeId: this.worktreeId,
        name: state.spec.name,
        cols: 120,
        rows: 30,
        command: launchCommand(state.spec)
      })
      terminalId = created.terminalId
    } catch (error) {
      this.note(state, errorMessage(error))
      state.status = 'failed'
      this.schedule()
      this.events.onChange()
      return
    }
    state.terminalId = terminalId
    void this.follow(state, terminalId)
  }

  private async follow(state: ProcessState, terminalId: string): Promise<void> {
    const { token, cancel } = cancellation()
    state.cancel = cancel

    let exitCode: number | null = null
    try {
      for await (const chunk of grove.terminals.read(terminalId, token)) {
        const item = chunk as { data?: string; exitCode?: number }
        if (typeof item.exitCode === 'number') exitCode = item.exitCode
        if (typeof item.data !== 'string') continue
        const shown = state.output.push(item.data)
        if (shown) this.events.onOutput(state.spec.name, shown)
      }
    } catch (error) {
      if (!token.isCancelled) this.note(state, errorMessage(error))
    }
    this.finish(state, terminalId, exitCode)
  }

  private finish(state: ProcessState, terminalId: string, exitCode: number | null): void {
    // Already finished (a kill that raced the exit), or a newer run took over.
    if (state.terminalId !== terminalId) return
    const stopping = state.status === 'stopping'
    state.terminalId = null
    state.cancel = null
    for (const waiter of state.exitWaiters.splice(0)) waiter()
    state.exitCode = exitCode
    if (stopping) state.status = 'stopped'
    else state.status = exitCode === 0 ? 'completed' : 'failed'
    this.schedule()
    this.events.onChange()
  }

  // Launches every waiting process whose dependencies are met, and skips the
  // ones whose dependencies can no longer be met.
  private schedule(): void {
    for (const state of this.processes.values()) {
      if (state.status !== 'waiting') continue
      const verdict = this.dependencyVerdict(state.spec)
      if (verdict === 'ready') void this.launch(state)
      else if (verdict === 'never') state.status = 'skipped'
    }
  }

  private dependencyVerdict(spec: ProcessSpec): 'ready' | 'wait' | 'never' {
    let verdict: 'ready' | 'wait' | 'never' = 'ready'
    for (const dependency of spec.dependsOn) {
      const target = this.processes.get(dependency.name)
      // Unknown and disabled dependencies don't hold anything back.
      if (!target || target.status === 'disabled') continue
      const met = conditionMet(dependency.condition, target.status)
      if (met === 'never') return 'never'
      if (met === 'wait') verdict = 'wait'
    }
    return verdict
  }
}

export function conditionMet(condition: string, status: ProcessStatus): 'ready' | 'wait' | 'never' {
  if (status === 'skipped' || status === 'stopped') return 'never'
  if (condition === 'process_completed_successfully') {
    if (status === 'completed') return 'ready'
    return status === 'failed' ? 'never' : 'wait'
  }
  if (condition === 'process_completed') {
    return status === 'completed' || status === 'failed' ? 'ready' : 'wait'
  }
  // process_started, and anything we can't observe (process_healthy,
  // process_log_ready): started is the best we know.
  return status === 'running' || status === 'completed' || status === 'failed' ? 'ready' : 'wait'
}

function isLive(status: ProcessStatus): boolean {
  return status === 'waiting' || status === 'running' || status === 'stopping'
}

// What is typed into the process's shell, whichever shell the user has. The
// script is POSIX sh and travels base64-encoded: what is typed is then only
// letters, digits and `+/="$()|` inside single quotes, which sh, bash, zsh
// and fish all read the same way. (Quoting the script itself can't be made to
// work for both: fish treats \' inside single quotes as an escape, POSIX
// shells don't.)
export function launchCommand(spec: ProcessSpec): string {
  return `exec sh -c 'eval "$(echo ${toBase64(wrapperScript(spec))} | base64 -d)"'`
}

function wrapperScript(spec: ProcessSpec): string {
  const exports = Object.entries(spec.environment)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
  return [
    `echo ${START_MARKER}`,
    ...exports,
    `cd ${shQuote(spec.workingDir)} || exit 1`,
    spec.command || 'echo "no command given" >&2; exit 1'
  ].join('\n')
}

// POSIX single quotes, with '\'' for an embedded quote.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
