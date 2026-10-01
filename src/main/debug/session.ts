// One Debug Adapter Protocol session: the handshake, the program's stops and
// threads, and the requests the UI (or an agent) makes against it.
//
// The handshake follows the spec's order: `initialize`, then `launch` or
// `attach` sent without waiting for its answer, then — once the adapter says
// `initialized` — breakpoints, exception filters and `configurationDone`.
// Many adapters (debugpy among them) only answer `launch` after that.

import { spawn, type ChildProcess } from 'node:child_process'
import type { DebugProtocol } from '@vscode/debugprotocol'
import type {
  DebugBreakpoint,
  DebugEvaluation,
  DebugExceptionFilter,
  DebugOutputCategory,
  DebugScope,
  DebugSessionState,
  DebugSessionSummary,
  DebugStackFrame,
  DebugThread,
  DebugVariable
} from '../../shared/debug'
import type { DapConnection } from './dapConnection'
import type { AdapterTransport } from './transport'

/** How many frames a stop loads up front. The UI asks for more on demand. */
const INITIAL_FRAME_COUNT = 50
/** How long a graceful terminate may take before the adapter is killed. */
const TERMINATE_GRACE_MS = 3000

/** What a session reports to the service that owns it. */
export interface DebugSessionHost {
  /** The session's summary changed. */
  changed(session: DebugSession): void
  /** A thread stopped and its frames are loaded. */
  stopped(session: DebugSession, threadId: number): void
  output(
    session: DebugSession,
    category: DebugOutputCategory,
    text: string,
    variablesReference?: number
  ): void
  /** The enabled breakpoints, by file, to send on configuration. */
  breakpointsByFile(): Map<string, DebugBreakpoint[]>
  /** The filters to enable, given the ones the adapter offers. */
  exceptionFiltersFor(type: string, offered: DebugProtocol.ExceptionBreakpointsFilter[]): string[]
  /** The adapter answered a setBreakpoints: which of ours it accepted. */
  breakpointsVerified(session: DebugSession, results: BreakpointVerification[]): void
  /** The adapter asked for a child session (`startDebugging`). */
  startChild(
    parent: DebugSession,
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>
  ): Promise<void>
  /** The session is over and its adapter gone. */
  ended(session: DebugSession): void
}

/** Whether the adapter accepted one of Grove's breakpoints, and why not. */
export interface BreakpointVerification {
  breakpointId: string
  verified: boolean
  message?: string
}

export interface DebugSessionOptions {
  id: string
  name: string
  type: string
  parentId: string | null
  worktreePath: string
  env: NodeJS.ProcessEnv
  host: DebugSessionHost
}

export class DebugSession {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly parentId: string | null
  readonly worktreePath: string

  state: DebugSessionState = 'initializing'
  capabilities: DebugProtocol.Capabilities = {}
  threads = new Map<number, DebugThread>()
  stoppedThreadId: number | null = null
  stopReason: string | null = null
  stopDescription: string | null = null
  exceptionFilters: DebugExceptionFilter[] = []
  /** Set once the handshake has sent breakpoints; later changes go out as they happen. */
  configured = false

  private connection: DapConnection | null = null
  private adapterProcess: ChildProcess | null = null
  private debuggees = new Set<ChildProcess>()
  /** The adapter's breakpoint ids, mapped to Grove's. */
  private adapterBreakpointIds = new Map<number, string>()
  private host: DebugSessionHost
  private env: NodeJS.ProcessEnv
  private terminateSent = false

  constructor(options: DebugSessionOptions) {
    this.id = options.id
    this.name = options.name
    this.type = options.type
    this.parentId = options.parentId
    this.worktreePath = options.worktreePath
    this.host = options.host
    this.env = options.env
  }

  /** Runs the handshake over a connected transport and starts the program. */
  async start(
    transport: AdapterTransport,
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>
  ): Promise<void> {
    this.connection = transport.connection
    this.adapterProcess = transport.process
    this.connection.onEvent((event) => this.handleEvent(event))
    this.connection.onReverseRequest((command, args) => this.handleReverseRequest(command, args))
    this.connection.onClose(() => this.finish())

    const initialized = new Promise<void>((resolve) => {
      const unsubscribe = this.connection?.onEvent((event) => {
        if (event.event !== 'initialized') {
          return
        }
        unsubscribe?.()
        resolve()
      })
    })
    this.capabilities =
      (await this.connection.request<DebugProtocol.Capabilities>(
        'initialize',
        initializeArguments(this.type)
      )) || {}
    this.host.changed(this)

    // No timeout: an attach can wait on the program for as long as it takes.
    const started = this.connection.request(request, configuration, 0)
    await Promise.race([initialized, started.then(() => initialized)])
    await this.configure()
    await started
    if (this.state === 'initializing') {
      this.state = 'running'
      this.host.changed(this)
    }
  }

  /** Sends breakpoints and exception filters, then `configurationDone`. */
  private async configure(): Promise<void> {
    for (const [path, breakpoints] of this.host.breakpointsByFile()) {
      await this.setBreakpoints(path, breakpoints).catch(() => undefined)
    }
    await this.sendExceptionFilters()
    this.configured = true
    if (this.capabilities.supportsConfigurationDoneRequest) {
      await this.request('configurationDone')
    }
  }

  private async sendExceptionFilters(): Promise<void> {
    const offered = this.capabilities.exceptionBreakpointFilters || []
    const enabled = this.host.exceptionFiltersFor(this.type, offered)
    this.exceptionFilters = offered.map((filter) => ({
      filter: filter.filter,
      label: filter.label,
      description: filter.description,
      enabled: enabled.includes(filter.filter)
    }))
    if (offered.length === 0) {
      return
    }
    await this.request('setExceptionBreakpoints', { filters: enabled }).catch(() => undefined)
  }

  /** Turns exception filters on or off for this session. */
  async setExceptionFilters(enabled: string[]): Promise<void> {
    this.exceptionFilters = this.exceptionFilters.map((filter) => ({
      ...filter,
      enabled: enabled.includes(filter.filter)
    }))
    this.host.changed(this)
    await this.request('setExceptionBreakpoints', { filters: enabled })
  }

  /** Replaces the breakpoints in one file and reports which the adapter accepted. */
  async setBreakpoints(path: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    const enabled = breakpoints.filter((breakpoint) => breakpoint.enabled)
    const body = await this.request<DebugProtocol.SetBreakpointsResponse['body']>(
      'setBreakpoints',
      {
        source: { path },
        breakpoints: enabled.map((breakpoint) => sourceBreakpointOf(breakpoint)),
        lines: enabled.map((breakpoint) => breakpoint.line)
      }
    )
    const results: BreakpointVerification[] = []
    const answered = body?.breakpoints || []
    enabled.forEach((breakpoint, index) => {
      const answer = answered[index]
      if (!answer) {
        results.push({ breakpointId: breakpoint.id, verified: false })
        return
      }
      if (typeof answer.id === 'number') {
        this.adapterBreakpointIds.set(answer.id, breakpoint.id)
      }
      results.push({
        breakpointId: breakpoint.id,
        verified: answer.verified,
        message: answer.message
      })
    })
    this.host.breakpointsVerified(this, results)
  }

  // ── Execution control ──────────────────────────────────────────

  async continue(threadId: number): Promise<void> {
    await this.request('continue', { threadId })
    this.markRunning(threadId, true)
  }

  async next(threadId: number): Promise<void> {
    await this.request('next', { threadId })
    this.markRunning(threadId, false)
  }

  async stepIn(threadId: number): Promise<void> {
    await this.request('stepIn', { threadId })
    this.markRunning(threadId, false)
  }

  async stepOut(threadId: number): Promise<void> {
    await this.request('stepOut', { threadId })
    this.markRunning(threadId, false)
  }

  async pause(threadId: number): Promise<void> {
    await this.request('pause', { threadId })
  }

  /** Restarts in place when the adapter can; the service restarts it otherwise. */
  async restart(configuration: Record<string, unknown>): Promise<void> {
    await this.request('restart', { arguments: configuration })
  }

  /**
   * Ends the program and the session: `terminate` first when the adapter has
   * it, so the program can clean up, then `disconnect`, then a kill.
   */
  async stop(): Promise<void> {
    if (this.state === 'terminated' || !this.connection) {
      this.finish()
      return
    }
    if (this.capabilities.supportsTerminateRequest && !this.terminateSent) {
      this.terminateSent = true
      const accepted = await this.request('terminate', {}, TERMINATE_GRACE_MS).then(
        () => true,
        () => false
      )
      if (accepted) {
        // The adapter answers with a `terminated` event, which comes back here
        // to disconnect. One that never sends it is let go of after the grace.
        setTimeout(() => this.finish(), TERMINATE_GRACE_MS).unref()
        return
      }
    }
    await this.request('disconnect', { terminateDebuggee: true }, TERMINATE_GRACE_MS).catch(
      () => undefined
    )
    this.finish()
  }

  // ── Inspection ─────────────────────────────────────────────────

  async stackTrace(
    threadId: number,
    startFrame: number,
    levels: number
  ): Promise<{ frames: DebugStackFrame[]; total: number | null }> {
    const body = await this.request<DebugProtocol.StackTraceResponse['body']>('stackTrace', {
      threadId,
      startFrame,
      levels
    })
    const frames = (body?.stackFrames || []).map((frame) => stackFrameOf(frame))
    let total: number | null = null
    if (typeof body?.totalFrames === 'number') {
      total = body.totalFrames
    }
    return { frames, total }
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const body = await this.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId })
    return (body?.scopes || []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive
    }))
  }

  async variables(variablesReference: number): Promise<DebugVariable[]> {
    const body = await this.request<DebugProtocol.VariablesResponse['body']>('variables', {
      variablesReference
    })
    return (body?.variables || []).map((variable) => ({
      name: variable.name,
      value: variable.value,
      type: variable.type,
      variablesReference: variable.variablesReference,
      evaluateName: variable.evaluateName
    }))
  }

  async evaluate(
    expression: string,
    frameId: number | null,
    context: string
  ): Promise<DebugEvaluation> {
    const args: DebugProtocol.EvaluateArguments = { expression, context }
    if (frameId !== null) {
      args.frameId = frameId
    }
    const body = await this.request<DebugProtocol.EvaluateResponse['body']>('evaluate', args)
    return {
      result: body?.result ?? '',
      type: body?.type,
      variablesReference: body?.variablesReference ?? 0
    }
  }

  summary(): DebugSessionSummary {
    return {
      id: this.id,
      name: this.name,
      parentId: this.parentId,
      type: this.type,
      worktreePath: this.worktreePath,
      state: this.state,
      threads: [...this.threads.values()],
      stoppedThreadId: this.stoppedThreadId,
      stopReason: this.stopReason,
      stopDescription: this.stopDescription,
      exceptionFilters: this.exceptionFilters,
      supportsRestart: Boolean(this.capabilities.supportsRestartRequest),
      supportsTerminate: Boolean(this.capabilities.supportsTerminateRequest),
      supportsCompletions: Boolean(this.capabilities.supportsCompletionsRequest)
    }
  }

  /** The adapter process, when this session spawned one. */
  get process(): ChildProcess | null {
    return this.adapterProcess
  }

  private request<Body = unknown>(
    command: string,
    args?: unknown,
    timeoutMs?: number
  ): Promise<Body> {
    if (!this.connection) {
      return Promise.reject(new Error('debug session is not connected'))
    }
    return this.connection.request<Body>(command, args, timeoutMs)
  }

  // ── Events from the adapter ────────────────────────────────────

  private handleEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case 'stopped':
        void this.handleStopped(event as DebugProtocol.StoppedEvent)
        return
      case 'continued':
        this.handleContinued(event as DebugProtocol.ContinuedEvent)
        return
      case 'thread':
        this.handleThread(event as DebugProtocol.ThreadEvent)
        return
      case 'output':
        this.handleOutput(event as DebugProtocol.OutputEvent)
        return
      case 'breakpoint':
        this.handleBreakpoint(event as DebugProtocol.BreakpointEvent)
        return
      case 'exited':
        this.handleExited(event as DebugProtocol.ExitedEvent)
        return
      case 'terminated':
        void this.stop()
        return
    }
  }

  private async handleStopped(event: DebugProtocol.StoppedEvent): Promise<void> {
    const body = event.body
    this.state = 'stopped'
    this.stopReason = body.reason
    this.stopDescription = body.text || body.description || null
    await this.refreshThreads()
    const threadId = this.stoppedThreadIdOf(body)
    this.stoppedThreadId = threadId
    for (const thread of this.threads.values()) {
      if (body.allThreadsStopped || thread.id === threadId) {
        thread.stopped = true
      }
    }
    if (threadId !== null) {
      await this.loadFrames(threadId)
    }
    this.host.changed(this)
    if (threadId !== null) {
      this.host.stopped(this, threadId)
    }
  }

  /** The thread a stop is about: the one it names, else the first thread there is. */
  private stoppedThreadIdOf(body: DebugProtocol.StoppedEvent['body']): number | null {
    if (typeof body.threadId === 'number') {
      return body.threadId
    }
    const first = this.threads.keys().next()
    if (first.done) {
      return null
    }
    return first.value
  }

  private async loadFrames(threadId: number): Promise<void> {
    const thread = this.threads.get(threadId)
    if (!thread) {
      return
    }
    try {
      const { frames, total } = await this.stackTrace(threadId, 0, INITIAL_FRAME_COUNT)
      thread.frames = frames
      thread.moreFrames = total !== null && total > frames.length
    } catch {
      thread.frames = []
      thread.moreFrames = false
    }
  }

  private async refreshThreads(): Promise<void> {
    let body: DebugProtocol.ThreadsResponse['body'] | undefined
    try {
      body = await this.request<DebugProtocol.ThreadsResponse['body']>('threads')
    } catch {
      return
    }
    const next = new Map<number, DebugThread>()
    for (const thread of body?.threads || []) {
      const known = this.threads.get(thread.id)
      next.set(thread.id, {
        id: thread.id,
        name: thread.name,
        stopped: known?.stopped ?? false,
        frames: known?.frames ?? [],
        moreFrames: known?.moreFrames ?? false
      })
    }
    this.threads = next
  }

  private handleContinued(event: DebugProtocol.ContinuedEvent): void {
    const allThreads = event.body.allThreadsContinued !== false
    this.markRunning(event.body.threadId, allThreads)
  }

  /** Clears what a stop loaded, once the program runs again. */
  private markRunning(threadId: number, allThreads: boolean): void {
    if (this.state === 'terminated') {
      return
    }
    for (const thread of this.threads.values()) {
      if (allThreads || thread.id === threadId) {
        thread.stopped = false
        thread.frames = []
        thread.moreFrames = false
      }
    }
    const anyStopped = [...this.threads.values()].some((thread) => thread.stopped)
    if (!anyStopped) {
      this.state = 'running'
      this.stoppedThreadId = null
      this.stopReason = null
      this.stopDescription = null
    }
    this.host.changed(this)
  }

  private handleThread(event: DebugProtocol.ThreadEvent): void {
    const { reason, threadId } = event.body
    if (reason === 'exited') {
      this.threads.delete(threadId)
    } else if (!this.threads.has(threadId)) {
      this.threads.set(threadId, {
        id: threadId,
        name: `Thread ${threadId}`,
        stopped: false,
        frames: [],
        moreFrames: false
      })
    }
    this.host.changed(this)
  }

  private handleOutput(event: DebugProtocol.OutputEvent): void {
    const category = outputCategoryOf(event.body.category)
    if (category === 'telemetry') {
      return
    }
    this.host.output(this, category, event.body.output, event.body.variablesReference)
  }

  private handleBreakpoint(event: DebugProtocol.BreakpointEvent): void {
    const breakpoint = event.body.breakpoint
    if (typeof breakpoint.id !== 'number') {
      return
    }
    const breakpointId = this.adapterBreakpointIds.get(breakpoint.id)
    if (!breakpointId) {
      return
    }
    this.host.breakpointsVerified(this, [
      { breakpointId, verified: breakpoint.verified, message: breakpoint.message }
    ])
  }

  private handleExited(event: DebugProtocol.ExitedEvent): void {
    this.host.output(this, 'console', `Process exited with code ${event.body.exitCode}\n`)
  }

  // ── Requests from the adapter ──────────────────────────────────

  private async handleReverseRequest(command: string, args: unknown): Promise<unknown> {
    if (command === 'runInTerminal') {
      return this.runInTerminal(args as DebugProtocol.RunInTerminalRequestArguments)
    }
    if (command === 'startDebugging') {
      const { request, configuration } = args as DebugProtocol.StartDebuggingRequestArguments
      await this.host.startChild(this, request, configuration)
      return {}
    }
    throw new Error(`${command} is not supported`)
  }

  /**
   * Runs the program the adapter asks for as a child process, its output going
   * to the Debug Console. A terminal pane would give it a tty and stdin (#327).
   */
  private runInTerminal(args: DebugProtocol.RunInTerminalRequestArguments): {
    processId: number | undefined
  } {
    const [command, ...commandArgs] = args.args
    const debuggee = spawn(command, commandArgs, {
      cwd: args.cwd || this.worktreePath,
      env: mergeEnvironment(this.env, args.env),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.debuggees.add(debuggee)
    debuggee.stdout?.on('data', (chunk: Buffer) =>
      this.host.output(this, 'stdout', chunk.toString())
    )
    debuggee.stderr?.on('data', (chunk: Buffer) =>
      this.host.output(this, 'stderr', chunk.toString())
    )
    debuggee.on('error', (error) =>
      this.host.output(this, 'error', `${command}: ${error.message}\n`)
    )
    debuggee.on('exit', () => this.debuggees.delete(debuggee))
    return { processId: debuggee.pid }
  }

  /** Marks the session over and lets go of everything it started. Idempotent. */
  private finish(): void {
    if (this.state === 'terminated') {
      return
    }
    this.state = 'terminated'
    this.stoppedThreadId = null
    for (const thread of this.threads.values()) {
      thread.stopped = false
      thread.frames = []
    }
    this.connection?.close()
    if (this.adapterProcess && this.adapterProcess.exitCode === null) {
      this.adapterProcess.kill()
    }
    for (const debuggee of this.debuggees) {
      debuggee.kill()
    }
    this.debuggees.clear()
    this.host.changed(this)
    this.host.ended(this)
  }
}

/** What Grove tells an adapter about itself in `initialize`. */
export function initializeArguments(adapterId: string): DebugProtocol.InitializeRequestArguments {
  return {
    clientID: 'grove',
    clientName: 'Grove',
    adapterID: adapterId,
    locale: 'en',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: true,
    supportsProgressReporting: false,
    supportsInvalidatedEvent: false,
    supportsMemoryReferences: false,
    supportsArgsCanBeInterpretedByShell: false
  }
}

function sourceBreakpointOf(breakpoint: DebugBreakpoint): DebugProtocol.SourceBreakpoint {
  const source: DebugProtocol.SourceBreakpoint = { line: breakpoint.line }
  if (breakpoint.condition) {
    source.condition = breakpoint.condition
  }
  if (breakpoint.hitCondition) {
    source.hitCondition = breakpoint.hitCondition
  }
  if (breakpoint.logMessage) {
    source.logMessage = breakpoint.logMessage
  }
  return source
}

export function stackFrameOf(frame: DebugProtocol.StackFrame): DebugStackFrame {
  const converted: DebugStackFrame = {
    id: frame.id,
    name: frame.name,
    line: frame.line,
    column: frame.column
  }
  if (frame.source?.path) {
    converted.path = frame.source.path
  }
  if (frame.source?.name) {
    converted.sourceName = frame.source.name
  }
  const hint = frame.presentationHint
  if (hint === 'normal' || hint === 'label' || hint === 'subtle') {
    converted.presentationHint = hint
  }
  if (frame.source?.presentationHint === 'deemphasize') {
    converted.presentationHint = 'subtle'
  }
  return converted
}

const OUTPUT_CATEGORIES = new Set<DebugOutputCategory>([
  'console',
  'stdout',
  'stderr',
  'important',
  'telemetry'
])

function outputCategoryOf(category: string | undefined): DebugOutputCategory {
  if (category && OUTPUT_CATEGORIES.has(category as DebugOutputCategory)) {
    return category as DebugOutputCategory
  }
  return 'console'
}

/** The adapter's environment additions over the session's own; null removes a variable. */
function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  additions: Record<string, string | null> | undefined
): NodeJS.ProcessEnv {
  const merged = { ...base }
  for (const [name, value] of Object.entries(additions || {})) {
    if (value === null) {
      delete merged[name]
    } else {
      merged[name] = value
    }
  }
  return merged
}
