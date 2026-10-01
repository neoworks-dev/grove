// The debugger: breakpoints, running sessions and what the UI is focused on.
//
// Everything that drives a debug session goes through this service — the
// Run and Debug view over IPC, the editor's gutter through nvim notifications,
// and (#239) an agent's tools — so they all see the same breakpoints and the
// same stops. Its state goes out whole as a DebugSnapshot on every change.

import { randomUUID } from 'node:crypto'
import type { DebugProtocol } from '@vscode/debugprotocol'
import type {
  DebugAdapterInfo,
  DebugBreakpoint,
  DebugBreakpointOptions,
  DebugConfigurationEntry,
  DebugEvaluation,
  DebugLocation,
  DebugOutputCategory,
  DebugOutputLine,
  DebugScope,
  DebugSnapshot,
  DebugStackFrame,
  DebugVariable,
  MasonDebugPackage
} from '../../shared/debug'
import type { AdapterContext, AdapterLaunch, DebugAdapterRegistry } from './registry'
import {
  listConfigurations,
  substituteVariables,
  type ConfigurationContext
} from './configurations'
import { DebugEditorSync, type NvimSessions } from './editorSync'
import {
  installMasonPackage,
  masonPackageInstalled,
  readMasonDebugCatalog,
  type HeadlessNvim
} from './mason'
import { DebugSession, type BreakpointVerification, type DebugSessionHost } from './session'
import { freePort, openChildTransport, openTransport } from './transport'

/** How many Debug Console lines are kept for a pane that opens late. */
const OUTPUT_LIMIT = 5000
const PERSIST_DELAY_MS = 500

/** What the debugger keeps per repository across restarts. */
export interface PersistedDebugState {
  breakpoints: DebugBreakpoint[]
  watches: string[]
}

export interface DebugServiceOptions {
  registry: DebugAdapterRegistry
  nvim: NvimSessions
  /** Push an event to the renderer. */
  send(channel: string, payload: unknown): void
  /** The environment a debug adapter runs with in a worktree. */
  environmentFor(worktreePath: string): NodeJS.ProcessEnv
  /** Mason's root directory in the editor's profile. */
  masonRoot(): string
  /** How to run the editor's nvim headless, for Mason installs. */
  headlessNvim(): HeadlessNvim
  load(repoPath: string): Promise<PersistedDebugState>
  save(repoPath: string, state: PersistedDebugState): Promise<void>
}

/** What starting a configuration needs besides the configuration itself. */
export interface StartRequest {
  worktreePath: string
  configuration: Record<string, unknown>
  activeFile?: string
  activeLine?: number
}

/** A session plus how to reach its adapter again, for child sessions and restarts. */
interface SessionRecord {
  session: DebugSession
  launch: AdapterLaunch
  request: StartRequest
  resolvedConfiguration: Record<string, unknown>
}

export class DebugService implements DebugSessionHost {
  private breakpoints: DebugBreakpoint[] = []
  private watches: string[] = []
  private sessions = new Map<string, SessionRecord>()
  /** Which sessions accepted which breakpoints, by breakpoint id. */
  private verifications = new Map<string, Map<string, BreakpointVerification>>()
  /** The exception filters chosen per adapter type, kept for the next session. */
  private exceptionChoices = new Map<string, string[]>()
  private focusedSessionId: string | null = null
  private focusedThreadId: number | null = null
  private focusedFrameId: number | null = null
  private stopSequence = 0
  private consoleLines: DebugOutputLine[] = []
  private outputSequence = 0
  private installing = new Set<string>()
  private repoPath: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotQueued = false
  private editorSync: DebugEditorSync

  constructor(private options: DebugServiceOptions) {
    this.editorSync = new DebugEditorSync(options.nvim)
  }

  /** Loads the breakpoints and watches kept for a repository as it opens. */
  async openRepo(repoPath: string): Promise<void> {
    if (this.repoPath === repoPath) {
      return
    }
    await this.stopAll()
    this.repoPath = repoPath
    const persisted = await this.options.load(repoPath)
    this.breakpoints = persisted.breakpoints.map((breakpoint) => ({
      ...breakpoint,
      verified: false
    }))
    this.watches = persisted.watches
    this.publish()
  }

  /** Everything the UI draws from. */
  snapshot(): DebugSnapshot {
    return {
      breakpoints: this.breakpoints.map((breakpoint) => this.withVerification(breakpoint)),
      sessions: [...this.sessions.values()].map((record) => record.session.summary()),
      focusedSessionId: this.focusedSessionId,
      focusedFrameId: this.focusedFrameId,
      focusedLocation: this.focusedLocation(),
      stopSequence: this.stopSequence,
      watches: this.watches
    }
  }

  /** The Debug Console's lines so far. */
  outputLines(): DebugOutputLine[] {
    return this.consoleLines
  }

  // ── Breakpoints ────────────────────────────────────────────────

  /** Adds a breakpoint on a line, or removes the one that is there. */
  async toggleBreakpoint(
    path: string,
    line: number,
    options: DebugBreakpointOptions = {}
  ): Promise<void> {
    const existing = this.breakpoints.find(
      (breakpoint) => breakpoint.path === path && breakpoint.line === line
    )
    if (existing) {
      await this.removeBreakpoint(existing.id)
      return
    }
    await this.setBreakpoint(path, line, options)
  }

  /** Adds a breakpoint, or updates the one on that line. Returns it. */
  async setBreakpoint(
    path: string,
    line: number,
    options: DebugBreakpointOptions = {}
  ): Promise<DebugBreakpoint> {
    let breakpoint = this.breakpoints.find(
      (candidate) => candidate.path === path && candidate.line === line
    )
    if (!breakpoint) {
      breakpoint = { id: randomUUID(), path, line, enabled: true, origin: 'user', verified: false }
      this.breakpoints = [...this.breakpoints, breakpoint]
    }
    applyBreakpointOptions(breakpoint, options)
    await this.breakpointsChanged(path)
    return this.withVerification(breakpoint)
  }

  async removeBreakpoint(id: string): Promise<void> {
    const breakpoint = this.breakpoints.find((candidate) => candidate.id === id)
    if (!breakpoint) {
      return
    }
    this.breakpoints = this.breakpoints.filter((candidate) => candidate.id !== id)
    this.verifications.delete(id)
    await this.breakpointsChanged(breakpoint.path)
  }

  async removeAllBreakpoints(): Promise<void> {
    const paths = new Set(this.breakpoints.map((breakpoint) => breakpoint.path))
    this.breakpoints = []
    this.verifications.clear()
    for (const path of paths) {
      await this.breakpointsChanged(path)
    }
  }

  async setBreakpointEnabled(id: string, enabled: boolean): Promise<void> {
    const breakpoint = this.breakpoints.find((candidate) => candidate.id === id)
    if (!breakpoint) {
      return
    }
    breakpoint.enabled = enabled
    await this.breakpointsChanged(breakpoint.path)
  }

  /**
   * Moves breakpoints to where the editor's marks for them ended up after an
   * edit, so a breakpoint stays on its statement when lines above it change.
   */
  async moveBreakpoints(path: string, moves: { id: string; line: number }[]): Promise<void> {
    let moved = false
    for (const move of moves) {
      const breakpoint = this.breakpoints.find((candidate) => candidate.id === move.id)
      if (!breakpoint || breakpoint.path !== path || breakpoint.line === move.line) {
        continue
      }
      breakpoint.line = move.line
      moved = true
    }
    if (moved) {
      this.dropDuplicateBreakpoints(path)
      await this.breakpointsChanged(path)
    }
  }

  /** Two marks pushed onto one line by a deletion leave one breakpoint there. */
  private dropDuplicateBreakpoints(path: string): void {
    const seen = new Set<number>()
    this.breakpoints = this.breakpoints.filter((breakpoint) => {
      if (breakpoint.path !== path) {
        return true
      }
      if (seen.has(breakpoint.line)) {
        return false
      }
      seen.add(breakpoint.line)
      return true
    })
  }

  /** Re-sends one file's breakpoints to every live session, then publishes. */
  private async breakpointsChanged(path: string): Promise<void> {
    this.publish()
    this.persist()
    const inFile = this.breakpoints.filter((breakpoint) => breakpoint.path === path)
    const sends = [...this.sessions.values()]
      .filter((record) => record.session.configured && record.session.state !== 'terminated')
      .map((record) => record.session.setBreakpoints(path, inFile).catch(() => undefined))
    await Promise.all(sends)
  }

  // ── Watches ────────────────────────────────────────────────────

  addWatch(expression: string): void {
    const trimmed = expression.trim()
    if (trimmed === '' || this.watches.includes(trimmed)) {
      return
    }
    this.watches = [...this.watches, trimmed]
    this.publish()
    this.persist()
  }

  removeWatch(expression: string): void {
    this.watches = this.watches.filter((watch) => watch !== expression)
    this.publish()
    this.persist()
  }

  // ── Adapters and configurations ────────────────────────────────

  /** Re-reads Mason's catalog, so newly installed or listed adapters show up. */
  async refreshAdapters(): Promise<void> {
    const catalog = await readMasonDebugCatalog(this.options.masonRoot())
    this.options.registry.setMasonCatalog(
      catalog.filter((entry) => masonPackageInstalled(this.options.masonRoot(), entry.name))
    )
  }

  async adapters(): Promise<DebugAdapterInfo[]> {
    await this.refreshAdapters()
    return this.options.registry.describe(this.installing)
  }

  /** Every DAP package Mason offers, with the installed ones marked. */
  async masonPackages(): Promise<MasonDebugPackage[]> {
    const root = this.options.masonRoot()
    const catalog = await readMasonDebugCatalog(root)
    return catalog.map((entry) => ({
      name: entry.name,
      languages: entry.languages,
      installed: masonPackageInstalled(root, entry.name)
    }))
  }

  async configurations(context: ConfigurationContext): Promise<DebugConfigurationEntry[]> {
    await this.refreshAdapters()
    return listConfigurations(this.options.registry, context)
  }

  /** Installs an adapter's Mason package. Resolves once it can start. */
  async installAdapter(masonPackage: string): Promise<void> {
    if (this.installing.has(masonPackage)) {
      return
    }
    this.installing.add(masonPackage)
    this.addOutput(null, 'console', `Installing ${masonPackage} with Mason…\n`)
    try {
      await installMasonPackage(this.options.headlessNvim(), masonPackage)
      this.addOutput(null, 'console', `Installed ${masonPackage}.\n`)
    } catch (error) {
      this.addOutput(null, 'error', `${(error as Error).message}\n`)
      throw error
    } finally {
      this.installing.delete(masonPackage)
      await this.refreshAdapters()
      this.publish()
    }
  }

  // ── Sessions ───────────────────────────────────────────────────

  /** Starts a configuration. Resolves with the session's id once it runs. */
  async start(request: StartRequest): Promise<string> {
    const { configuration, unresolved } = substituteVariables(request.configuration, {
      worktreePath: request.worktreePath,
      activeFile: request.activeFile,
      activeLine: request.activeLine,
      env: this.options.environmentFor(request.worktreePath)
    })
    if (unresolved.length > 0) {
      throw new Error(`Grove cannot fill in ${unresolved.join(', ')} in this configuration`)
    }
    await this.refreshAdapters()
    const type = String(configuration.type)
    const { launch, resolvedConfiguration } = await this.adapterLaunchFor(type, configuration, {
      worktreePath: request.worktreePath,
      env: this.options.environmentFor(request.worktreePath)
    })
    const session = this.createSession(request, String(configuration.name), type, null)
    const record: SessionRecord = { session, launch, request, resolvedConfiguration }
    this.sessions.set(session.id, record)
    this.focusedSessionId = session.id
    this.publish()
    try {
      const transport = await openTransport(launch, this.transportOptions(session))
      await session.start(transport, requestKindOf(resolvedConfiguration), resolvedConfiguration)
    } catch (error) {
      this.addOutput(session.id, 'error', `${(error as Error).message}\n`)
      await session.stop()
      throw error
    }
    return session.id
  }

  /** How to reach the adapter for a type, and the configuration to send it. */
  private async adapterLaunchFor(
    type: string,
    configuration: Record<string, unknown>,
    context: AdapterContext
  ): Promise<{ launch: AdapterLaunch; resolvedConfiguration: Record<string, unknown> }> {
    if (typeof configuration.debugServer === 'number') {
      const launch: AdapterLaunch = {
        kind: 'socket',
        host: '127.0.0.1',
        port: configuration.debugServer
      }
      return { launch, resolvedConfiguration: configuration }
    }
    const descriptor = this.options.registry.forType(type)
    if (!descriptor) {
      throw new Error(`No debug adapter for type "${type}"`)
    }
    const { executablePath } = this.options.registry.resolve(descriptor)
    if (!executablePath) {
      throw new Error(`${descriptor.label} is not installed`)
    }
    let resolvedConfiguration = { ...configuration }
    if (descriptor.resolveConfiguration) {
      resolvedConfiguration = descriptor.resolveConfiguration(resolvedConfiguration, context)
    }
    const port = await freePort()
    return { launch: descriptor.launch(executablePath, port), resolvedConfiguration }
  }

  private createSession(
    request: StartRequest,
    name: string,
    type: string,
    parentId: string | null
  ): DebugSession {
    return new DebugSession({
      id: randomUUID(),
      name,
      type,
      parentId,
      worktreePath: request.worktreePath,
      env: this.options.environmentFor(request.worktreePath),
      host: this
    })
  }

  private transportOptions(session: DebugSession): Parameters<typeof openTransport>[1] {
    return {
      cwd: session.worktreePath,
      env: this.options.environmentFor(session.worktreePath),
      onAdapterLog: (text) => console.warn(`[debug ${session.type}]`, text.trimEnd())
    }
  }

  /** Stops a session and the children it started. */
  async stop(sessionId?: string): Promise<void> {
    const record = this.recordFor(sessionId)
    if (!record) {
      return
    }
    const root = this.rootOf(record.session)
    await Promise.all(this.familyOf(root).map((member) => member.stop()))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((record) => record.session.stop()))
  }

  /** Restarts a session: in place when its adapter can, else stop and start again. */
  async restart(sessionId?: string): Promise<void> {
    const record = this.recordFor(sessionId)
    if (!record) {
      return
    }
    const rootRecord = this.sessions.get(this.rootOf(record.session).id)
    if (!rootRecord) {
      return
    }
    if (rootRecord.session.capabilities.supportsRestartRequest) {
      await rootRecord.session.restart(rootRecord.resolvedConfiguration)
      return
    }
    await this.stop(rootRecord.session.id)
    await this.start(rootRecord.request)
  }

  async continue(sessionId?: string, threadId?: number): Promise<void> {
    await this.onThread(sessionId, threadId, (session, thread) => session.continue(thread))
  }

  async pause(sessionId?: string, threadId?: number): Promise<void> {
    await this.onThread(sessionId, threadId, (session, thread) => session.pause(thread))
  }

  async stepOver(sessionId?: string, threadId?: number): Promise<void> {
    await this.onThread(sessionId, threadId, (session, thread) => session.next(thread))
  }

  async stepInto(sessionId?: string, threadId?: number): Promise<void> {
    await this.onThread(sessionId, threadId, (session, thread) => session.stepIn(thread))
  }

  async stepOut(sessionId?: string, threadId?: number): Promise<void> {
    await this.onThread(sessionId, threadId, (session, thread) => session.stepOut(thread))
  }

  /** Runs an execution command on a thread: the one named, else the focused or stopped one. */
  private async onThread(
    sessionId: string | undefined,
    threadId: number | undefined,
    command: (session: DebugSession, threadId: number) => Promise<void>
  ): Promise<void> {
    const record = this.recordFor(sessionId)
    if (!record) {
      return
    }
    const thread = this.threadFor(record.session, threadId)
    if (thread === null) {
      return
    }
    await command(record.session, thread)
  }

  private threadFor(session: DebugSession, threadId: number | undefined): number | null {
    if (threadId !== undefined) {
      return threadId
    }
    if (session.id === this.focusedSessionId && this.focusedThreadId !== null) {
      return this.focusedThreadId
    }
    if (session.stoppedThreadId !== null) {
      return session.stoppedThreadId
    }
    const first = session.threads.keys().next()
    if (first.done) {
      return null
    }
    return first.value
  }

  /** Points the UI at a session, thread and frame: the variables view and evaluate follow. */
  focus(sessionId: string, threadId: number | null, frameId: number | null): void {
    this.focusedSessionId = sessionId
    this.focusedThreadId = threadId
    this.focusedFrameId = frameId
    this.publish()
  }

  async setExceptionFilters(sessionId: string, filters: string[]): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return
    }
    this.exceptionChoices.set(record.session.type, filters)
    await record.session.setExceptionFilters(filters)
  }

  // ── Inspection ─────────────────────────────────────────────────

  async stackTrace(
    sessionId: string,
    threadId: number,
    startFrame: number,
    levels: number
  ): Promise<{ frames: DebugStackFrame[]; total: number | null }> {
    return this.requireSession(sessionId).stackTrace(threadId, startFrame, levels)
  }

  /** The scopes of a frame: the focused one when none is named. */
  async scopes(sessionId?: string, frameId?: number): Promise<DebugScope[]> {
    const record = this.recordFor(sessionId)
    let frame = frameId
    if (frame === undefined && this.focusedFrameId !== null) {
      frame = this.focusedFrameId
    }
    if (!record || frame === undefined) {
      return []
    }
    return record.session.scopes(frame)
  }

  async variables(sessionId: string, variablesReference: number): Promise<DebugVariable[]> {
    return this.requireSession(sessionId).variables(variablesReference)
  }

  /**
   * Evaluates an expression in a frame — the focused one when none is named.
   * `repl` input is echoed to the Debug Console with its result.
   */
  async evaluate(
    expression: string,
    context: 'repl' | 'watch' | 'hover',
    sessionId?: string,
    frameId?: number
  ): Promise<DebugEvaluation> {
    const record = this.recordFor(sessionId)
    if (!record) {
      throw new Error('No debug session is running')
    }
    let frame: number | null = null
    if (frameId !== undefined) {
      frame = frameId
    } else if (record.session.id === this.focusedSessionId) {
      frame = this.focusedFrameId
    }
    if (context !== 'repl') {
      return record.session.evaluate(expression, frame, context)
    }
    this.addOutput(record.session.id, 'input', `${expression}\n`)
    try {
      const evaluation = await record.session.evaluate(expression, frame, context)
      this.addOutput(
        record.session.id,
        'result',
        `${evaluation.result}\n`,
        evaluation.variablesReference
      )
      return evaluation
    } catch (error) {
      this.addOutput(record.session.id, 'error', `${(error as Error).message}\n`)
      throw error
    }
  }

  clearOutput(): void {
    this.consoleLines = []
    this.options.send('event:debug-output-cleared', {})
  }

  // ── Editor notifications ───────────────────────────────────────

  /** Handles what debug.lua tells Grove: a gutter click, moved marks, a new editor. */
  handleNvimNotify(nvimSessionId: string, method: string, args: unknown[]): boolean {
    const payload = (args[0] || {}) as Record<string, unknown>
    if (method === 'grove_debug_ready') {
      this.editorSync.pushTo(nvimSessionId)
      return true
    }
    if (method === 'grove_debug_toggle_breakpoint') {
      const line = Number(payload.line)
      if (typeof payload.path === 'string' && payload.path !== '' && Number.isInteger(line)) {
        void this.toggleBreakpoint(payload.path, line)
      }
      return true
    }
    if (method === 'grove_debug_breakpoints_moved') {
      if (typeof payload.path === 'string' && Array.isArray(payload.moves)) {
        void this.moveBreakpoints(payload.path, payload.moves as { id: string; line: number }[])
      }
      return true
    }
    return false
  }

  // ── DebugSessionHost: what sessions report ─────────────────────

  changed(): void {
    this.publish()
  }

  stopped(session: DebugSession, threadId: number): void {
    const thread = session.threads.get(threadId)
    this.focusedSessionId = session.id
    this.focusedThreadId = threadId
    this.focusedFrameId = null
    if (thread) {
      this.focusedFrameId = focusFrameOf(thread.frames)
    }
    this.stopSequence += 1
    this.publish()
  }

  output(
    session: DebugSession,
    category: DebugOutputCategory,
    text: string,
    variablesReference?: number
  ): void {
    this.addOutput(session.id, category, text, variablesReference)
  }

  breakpointsByFile(): Map<string, DebugBreakpoint[]> {
    const byFile = new Map<string, DebugBreakpoint[]>()
    for (const breakpoint of this.breakpoints) {
      const inFile = byFile.get(breakpoint.path) || []
      inFile.push(breakpoint)
      byFile.set(breakpoint.path, inFile)
    }
    return byFile
  }

  exceptionFiltersFor(type: string, offered: DebugProtocol.ExceptionBreakpointsFilter[]): string[] {
    const chosen = this.exceptionChoices.get(type)
    if (chosen) {
      return chosen.filter((filter) => offered.some((candidate) => candidate.filter === filter))
    }
    return offered.filter((filter) => filter.default).map((filter) => filter.filter)
  }

  breakpointsVerified(session: DebugSession, results: BreakpointVerification[]): void {
    for (const result of results) {
      const bySession = this.verifications.get(result.breakpointId) || new Map()
      bySession.set(session.id, result)
      this.verifications.set(result.breakpointId, bySession)
    }
    this.publish()
  }

  async startChild(
    parent: DebugSession,
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>
  ): Promise<void> {
    const parentRecord = this.sessions.get(parent.id)
    if (!parentRecord) {
      throw new Error('parent session is gone')
    }
    let name = parent.name
    if (typeof configuration.name === 'string') {
      name = configuration.name
    }
    const child = this.createSession(parentRecord.request, name, parent.type, parent.id)
    this.sessions.set(child.id, {
      ...parentRecord,
      session: child,
      resolvedConfiguration: configuration
    })
    this.publish()
    try {
      const transport = await openChildTransport(parentRecord.launch, this.transportOptions(child))
      await child.start(transport, request, configuration)
    } catch (error) {
      this.addOutput(child.id, 'error', `${(error as Error).message}\n`)
      await child.stop()
    }
  }

  ended(session: DebugSession): void {
    this.sessions.delete(session.id)
    for (const bySession of this.verifications.values()) {
      bySession.delete(session.id)
    }
    for (const record of this.sessions.values()) {
      if (record.session.parentId === session.id) {
        void record.session.stop()
      }
    }
    if (this.focusedSessionId === session.id) {
      this.focusNextSession()
    }
    this.publish()
  }

  private focusNextSession(): void {
    const next = [...this.sessions.values()].find((record) => record.session.state !== 'terminated')
    this.focusedSessionId = null
    this.focusedThreadId = null
    this.focusedFrameId = null
    if (next) {
      this.focusedSessionId = next.session.id
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private recordFor(sessionId: string | undefined): SessionRecord | undefined {
    if (sessionId) {
      return this.sessions.get(sessionId)
    }
    if (this.focusedSessionId) {
      return this.sessions.get(this.focusedSessionId)
    }
    return this.sessions.values().next().value
  }

  private requireSession(sessionId: string): DebugSession {
    const record = this.sessions.get(sessionId)
    if (!record) {
      throw new Error('That debug session has ended')
    }
    return record.session
  }

  private rootOf(session: DebugSession): DebugSession {
    let current = session
    while (current.parentId) {
      const parent = this.sessions.get(current.parentId)
      if (!parent) {
        break
      }
      current = parent.session
    }
    return current
  }

  /** A session and every session below it. */
  private familyOf(root: DebugSession): DebugSession[] {
    const family = [root]
    for (const record of this.sessions.values()) {
      if (record.session.parentId === root.id) {
        family.push(...this.familyOf(record.session))
      }
    }
    return family
  }

  /** A breakpoint, verified when any live session accepted it. */
  private withVerification(breakpoint: DebugBreakpoint): DebugBreakpoint {
    const results = [...(this.verifications.get(breakpoint.id)?.values() || [])]
    const accepted = results.find((result) => result.verified)
    if (accepted) {
      return { ...breakpoint, verified: true, message: undefined }
    }
    const rejected = results.find((result) => result.message)
    return { ...breakpoint, verified: false, message: rejected?.message }
  }

  private focusedLocation(): DebugLocation | null {
    const record = this.recordFor(undefined)
    if (!record || this.focusedFrameId === null) {
      return null
    }
    for (const thread of record.session.threads.values()) {
      const frame = thread.frames.find((candidate) => candidate.id === this.focusedFrameId)
      if (frame && frame.path) {
        return { path: frame.path, line: frame.line }
      }
    }
    return null
  }

  private addOutput(
    sessionId: string | null,
    category: DebugOutputCategory,
    text: string,
    variablesReference?: number
  ): void {
    this.outputSequence += 1
    const line: DebugOutputLine = { sequence: this.outputSequence, sessionId, category, text }
    if (variablesReference) {
      line.variablesReference = variablesReference
    }
    this.consoleLines.push(line)
    if (this.consoleLines.length > OUTPUT_LIMIT) {
      this.consoleLines.splice(0, this.consoleLines.length - OUTPUT_LIMIT)
    }
    this.options.send('event:debug-output', line)
  }

  /**
   * Sends the snapshot to the renderer and the editors. Batched to one per
   * tick: a stop changes threads, frames and focus in quick succession.
   */
  private publish(): void {
    if (this.snapshotQueued) {
      return
    }
    this.snapshotQueued = true
    queueMicrotask(() => {
      this.snapshotQueued = false
      const snapshot = this.snapshot()
      this.options.send('event:debug-state', snapshot)
      const sessionActive = snapshot.sessions.some((session) => session.state !== 'terminated')
      this.editorSync.update(snapshot.breakpoints, snapshot.focusedLocation, sessionActive)
    })
  }

  private persist(): void {
    const repoPath = this.repoPath
    if (!repoPath) {
      return
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      const breakpoints = this.breakpoints.map((breakpoint) => ({ ...breakpoint, verified: false }))
      void this.options.save(repoPath, { breakpoints, watches: this.watches })
    }, PERSIST_DELAY_MS)
  }
}

function applyBreakpointOptions(
  breakpoint: DebugBreakpoint,
  options: DebugBreakpointOptions
): void {
  if (options.condition !== undefined) {
    breakpoint.condition = options.condition || undefined
  }
  if (options.hitCondition !== undefined) {
    breakpoint.hitCondition = options.hitCondition || undefined
  }
  if (options.logMessage !== undefined) {
    breakpoint.logMessage = options.logMessage || undefined
  }
  if (options.origin !== undefined) {
    breakpoint.origin = options.origin
  }
}

/** `launch` unless the configuration asks to attach. */
function requestKindOf(configuration: Record<string, unknown>): 'launch' | 'attach' {
  if (configuration.request === 'attach') {
    return 'attach'
  }
  return 'launch'
}

/**
 * The frame a stop focuses: the top one with a file on disk, so stopping
 * inside a library's compiled code still shows the user's own line.
 */
export function focusFrameOf(frames: DebugStackFrame[]): number | null {
  const withSource = frames.find((frame) => frame.path && frame.presentationHint !== 'subtle')
  if (withSource) {
    return withSource.id
  }
  if (frames.length > 0) {
    return frames[0].id
  }
  return null
}
