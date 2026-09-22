// The agent service: sessions, runs and everything the renderer talks to.
//
// One session is a stored record plus, while grove is running, a harness run and
// the state that only exists in memory — status, the message queue, and the tool
// calls parked waiting for an answer. Adapters report progress by emitting event
// bodies; this stamps them onto the log and keeps the runtime state in step.
//
// Nothing here knows how any particular harness works. Swapping Claude for Codex
// changes which descriptor `start()` is called on and nothing else.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  BlobDescriptor,
  ClientEventBody,
  ConfirmationResult,
  CreateSessionOptions,
  DeliverAs,
  FileMatch,
  HarnessCatalog,
  HarnessInfo,
  ImageBlock,
  ModelEntry,
  QueuedMessage,
  ServerEventBody,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate,
  ShellCompletion,
  ThinkingLevel,
  ToolInfo,
  UserContentBlock
} from '../../shared/agents'
import { ATTACHABLE_IMAGE_TYPES } from '../../shared/agents'
import * as files from '../files'
import { PARENT_LABEL } from './handoffBridge'
import type {
  ApprovalDecision,
  ApprovalRequest,
  GroveTool,
  HarnessRegistry,
  HarnessRun,
  PromptAttachment,
  SubagentIdentity
} from './harness'
import { runShellCommand, type ShellResult } from './shell'
import { completeShellLine } from './shellCompletion'
import { resolveLoginShell } from './loginShell'
import {
  hasStarted,
  idleRuntime,
  SessionStore,
  type RuntimeState,
  type StoredSession
} from './store'
import { isSubagentSession, SUBAGENT_LABEL, SubagentSessions } from './subagents'

const BLOBS_DIR = 'blobs'

interface PendingApproval {
  name: string
  resolve: (decision: ApprovalDecision) => void
}

/** The in-memory half of a session, dropped when grove exits. */
interface Runtime extends RuntimeState {
  run: HarnessRun | null
  starting: Promise<HarnessRun> | null
  approvals: Map<string, PendingApproval>
  /** Tool calls already announced on the log, so an adapter cannot double-report. */
  announced: Set<string>
  messageCount: number
}

export interface AgentServiceOptions {
  store: SessionStore
  harnesses: HarnessRegistry
  /** grove's own tools, offered to every harness that can host them. */
  tools: () => GroveTool[]
  /**
   * What grove adds to the harness's own system prompt for one session — who
   * the agent is in this worktree and who else is in it. Built per run, since
   * the answer changes as sessions come and go. A service without one runs the
   * harness on its own prompt alone.
   */
  systemPrompt?: (session: StoredSession) => Promise<string>
  /**
   * Told about a session that has just been removed, with the record it had
   * while it still existed. Whoever was depending on it — an agent waiting for
   * it to report back — hears about the removal here.
   */
  sessionRemoved?: (session: StoredSession) => Promise<void>
  /** Push an event to the renderer. */
  publish(event: SessionEvent): void
  /** The harness to use when a session does not name one. */
  defaultHarness: () => string | undefined
  /** Where man-page completions generated for fish are kept. */
  shellCompletionsDir?: string
}

export class AgentService {
  private runtimes = new Map<string, Runtime>()

  /**
   * The sessions standing for the agents harnesses run inside their tool calls.
   * Opening one is the same call the `spawn_agent` tool makes, so a delegated
   * conversation is a session whoever started it.
   */
  private subagents = new SubagentSessions({
    open: (parentSessionId, agent) => this.openSubagentSession(parentSessionId, agent),
    absorb: (sessionId, body) => this.absorb(sessionId, body)
  })

  constructor(private options: AgentServiceOptions) {}

  private get store(): SessionStore {
    return this.options.store
  }

  // ── Harnesses and catalogs ──────────────────────────────────────

  harnesses(): Promise<HarnessInfo[]> {
    return this.options.harnesses.describe()
  }

  /** Models, commands and skills for one harness, for the composer and pickers. */
  async catalog(harnessId: string): Promise<HarnessCatalog> {
    const descriptor = this.options.harnesses.require(harnessId)
    const offering = await descriptor.offering()
    // A harness reports the tools it brings; grove's own are added here, since
    // they are the same set whichever runtime is hosting them — and without
    // them the transcript has no `display` for the calls it shows most.
    const tools = [...offering.tools, ...this.toolsFor(descriptor).map(toolInfoOf)]
    return { harness: harnessId, ...offering, tools }
  }

  // ── Session lifecycle ───────────────────────────────────────────

  async listSessions(): Promise<SessionMeta[]> {
    const stored = await this.store.list()
    return stored.map((session) =>
      SessionStore.metaOf(session, this.isLive(session.id), this.runtimeOf(session.id))
    )
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
    const harness = this.resolveHarness(options.harness)
    const workspaceRoot = options.workspace
    if (!workspaceRoot) throw new Error('a session needs a workspace')

    const model = await this.startingModel(harness, options)

    const session = await this.store.create({
      workspaceRoot,
      harness,
      title: options.title ?? 'Session',
      provider: model.provider,
      model: model.model,
      thinkingLevel: options.thinkingLevel ?? 'off',
      activeTools: options.activeTools ?? null,
      labels: options.labels
    })
    return this.snapshot(session)
  }

  /**
   * The model a new session opens on.
   *
   * A caller that names one gets it. Otherwise the harness is asked what it
   * recommends, so nothing has to be typed in before the first turn — and a
   * harness that cannot say leaves the fields empty, as before.
   */
  private async startingModel(
    harness: string,
    options: CreateSessionOptions
  ): Promise<{ provider: string; model: string }> {
    if (options.model) {
      return { provider: options.provider ?? '', model: options.model }
    }
    const recommended = await this.recommendedModel(harness)
    if (recommended) return recommended
    return { provider: options.provider ?? '', model: '' }
  }

  /** What a harness would pick for itself, or null when it cannot say. */
  private async recommendedModel(
    harness: string
  ): Promise<{ provider: string; model: string } | null> {
    try {
      const offering = await this.options.harnesses.require(harness).offering()
      return offering.default
    } catch {
      // A harness that fails to answer must not stop a session being created.
      return null
    }
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return this.snapshot(await this.store.require(sessionId))
  }

  async updateSession(
    sessionId: string,
    changes: SessionUpdate
  ): Promise<{ changed: string[]; session: SessionSnapshot }> {
    const before = await this.store.require(sessionId)
    const changed = Object.keys(changes).filter(
      (key) => (changes as Record<string, unknown>)[key] !== undefined
    )
    if (changes.harness && changes.harness !== before.harness) {
      // The transcript belongs to the runtime that produced it: another harness
      // cannot resume it, and re-reading it as plain text would lose the tool
      // calls. So a started session keeps its harness; only the model is open.
      if (hasStarted(before)) {
        throw new Error('The harness cannot be changed once a session has started')
      }
      await this.stopRun(sessionId)
      await this.store.patch(sessionId, { resumeKey: null })
    }

    const session = await this.store.patch(sessionId, changes as Partial<StoredSession>)
    await this.applyLiveChanges(sessionId, changes)
    if (changed.length > 0) {
      await this.store.append(sessionId, { type: 'session.info_changed', changed })
    }
    return { changed, session: this.snapshot(session) }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.store.get(sessionId)
    await this.stopRun(sessionId)
    this.runtimes.delete(sessionId)
    await this.store.remove(sessionId)
    if (session) await this.announceRemoval(session)
  }

  /** Announcing a removal must not be able to fail the removal itself. */
  private async announceRemoval(session: StoredSession): Promise<void> {
    if (!this.options.sessionRemoved) return
    await this.options.sessionRemoved(session).catch(() => {})
  }

  listEvents(sessionId: string, after = 0): Promise<SessionEvent[]> {
    return this.store.eventsSince(sessionId, after)
  }

  // ── Client events ───────────────────────────────────────────────

  /** Accept a batch of client events, in order. */
  async send(sessionId: string, events: ClientEventBody[]): Promise<{ lastSeq: number }> {
    for (const event of events) await this.accept(sessionId, event)
    const session = await this.store.require(sessionId)
    return { lastSeq: session.lastSeq }
  }

  private async accept(sessionId: string, event: ClientEventBody): Promise<void> {
    if (event.type === 'user.tool_confirmation') {
      await this.store.append(sessionId, event)
      await this.answerApproval(sessionId, event.toolUseId, event.result, event.input)
      return
    }
    if (event.type === 'user.interrupt') {
      await this.store.append(sessionId, event)
      await this.interruptRun(sessionId)
      return
    }
    if (event.type === 'user.unqueue') {
      await this.store.append(sessionId, event)
      this.dropQueued(sessionId, event.messageId)
      return
    }
    if (event.type === 'user.message' || event.type === 'app.message') {
      await this.deliver(sessionId, event)
      return
    }
    if (event.type === 'user.command') {
      await this.store.append(sessionId, event)
      await this.runCommand(sessionId, event.name, event.args)
      return
    }
    if (event.type === 'user.shell') {
      await this.store.append(sessionId, event)
      await this.runShell(sessionId, event.command, event.share === true)
      return
    }
    // Compaction and branching belong to the harness; the ones that cannot do
    // them say so rather than silently dropping the ask.
    await this.store.append(sessionId, event)
    await this.store.append(sessionId, {
      type: 'session.notice',
      message: `"${event.type}" is not supported by this harness`
    })
  }

  /** Put a message to the agent: straight through, steered, or queued. */
  private async deliver(
    sessionId: string,
    event: Extract<ClientEventBody, { type: 'user.message' | 'app.message' }>
  ): Promise<void> {
    if (await this.isSubagentSession(sessionId)) {
      await this.store.append(sessionId, {
        type: 'session.notice',
        message: 'This agent was run inside a tool call and cannot be written to.'
      })
      return
    }
    // Read before the message lands on the log: it is the message itself that
    // ends the wait for everything run before it.
    const pending = await this.pendingShellContext(sessionId)
    const stamped = await this.store.append(sessionId, event)
    const runtime = this.runtimeOrCreate(sessionId)
    const text = withPendingShell(pending, textOf(event))
    const attachments = await this.attachmentsFor(sessionId, event)
    runtime.messageCount += 1

    if (runtime.status !== 'running') {
      await this.startTurn(sessionId, text, attachments)
      return
    }

    const deliverAs: DeliverAs = event.deliverAs ?? 'followUp'
    const run = runtime.run
    if (deliverAs === 'steer' && run?.steer) {
      await run.steer(text, deliverAs).catch((cause: Error) => this.reportError(sessionId, cause))
      return
    }
    runtime.queued = [...runtime.queued, { id: stamped.id, text, deliverAs, attachments }]
  }

  /**
   * The images on a message, or none when this harness cannot take them.
   *
   * A harness that ignores attachments is told about in a notice rather than
   * being handed bytes it will drop: an image that silently never reaches the
   * model looks to the user exactly like one that did.
   */
  private async attachmentsFor(
    sessionId: string,
    event: Extract<ClientEventBody, { type: 'user.message' | 'app.message' }>
  ): Promise<ImageBlock[]> {
    if (event.type !== 'user.message') return []
    const images = event.content.filter((block): block is ImageBlock => block.type === 'image')
    if (images.length === 0) return []

    const session = await this.store.require(sessionId)
    const descriptor = this.options.harnesses.get(session.harness)
    if (descriptor?.capabilities.attachments !== true) {
      await this.noticeDroppedAttachments(sessionId, images.length, session.harness)
      return []
    }

    const attachable = images.filter((image) => ATTACHABLE_IMAGE_TYPES.includes(image.mediaType))
    if (attachable.length < images.length) {
      await this.store.append(sessionId, {
        type: 'session.notice',
        message: `${images.length - attachable.length} attachment(s) were left out: only ${ATTACHABLE_IMAGE_TYPES.join(', ')} can be sent.`
      })
    }
    return attachable
  }

  private async noticeDroppedAttachments(
    sessionId: string,
    count: number,
    harness: string
  ): Promise<void> {
    await this.store.append(sessionId, {
      type: 'session.notice',
      message: `${count} attachment(s) were not sent: the ${harness} harness does not accept images.`
    })
  }

  /** Read the attached blobs back as base64, ready for the harness. */
  private async resolveAttachments(
    sessionId: string,
    images: ImageBlock[]
  ): Promise<PromptAttachment[]> {
    const resolved: PromptAttachment[] = []
    for (const image of images) {
      try {
        const bytes = await this.readBlob(sessionId, image.ref)
        resolved.push({ mediaType: image.mediaType, data: bytes.toString('base64') })
      } catch (cause) {
        await this.store.append(sessionId, {
          type: 'session.notice',
          message: `an attachment could not be read: ${(cause as Error).message}`
        })
      }
    }
    return resolved
  }

  /**
   * Stop the turn in flight.
   *
   * A stop that cannot land says so in the conversation: silence here reads as a
   * dead button, which is the one thing someone pressing Stop cannot act on.
   */
  private async interruptRun(sessionId: string): Promise<void> {
    const run = this.runtimeOrCreate(sessionId).run
    if (!run) {
      await this.store.append(sessionId, {
        type: 'session.notice',
        message: 'Nothing to stop: this session has no run.'
      })
      return
    }
    try {
      await run.interrupt()
    } catch (cause) {
      await this.store.append(sessionId, {
        type: 'session.notice',
        message: `Stopping the agent failed: ${(cause as Error).message}`
      })
    }
  }

  /** Is this the record of an agent a harness ran, rather than a live conversation? */
  private async isSubagentSession(sessionId: string): Promise<boolean> {
    const session = await this.store.get(sessionId)
    if (!session) return false
    return isSubagentSession(session)
  }

  /** Take a message back out of the queue before it is delivered. */
  private dropQueued(sessionId: string, messageId: string): void {
    const runtime = this.runtimeOrCreate(sessionId)
    runtime.queued = runtime.queued.filter((message) => message.id !== messageId)
  }

  /**
   * Run a slash command on the harness.
   *
   * Support is a property of the run rather than the descriptor, so the run has
   * to exist before the ask can be answered either way.
   */
  private async runCommand(sessionId: string, name: string, args: string): Promise<void> {
    try {
      const run = await this.ensureRun(sessionId)
      if (!run.command) {
        await this.store.append(sessionId, {
          type: 'session.notice',
          message: `"/${name}" is not supported by this harness`
        })
        return
      }
      await run.command(name, args)
    } catch (cause) {
      await this.reportError(sessionId, cause as Error)
    }
  }

  /**
   * Run a `!` command in the session's worktree.
   *
   * The shell is grove's, not the harness's: every runtime gets the same `!`,
   * including the ones whose SDK has no passthrough of its own. A shared command
   * is held for the next message rather than sent on its own — running one is
   * looking something up, not starting a turn.
   */
  private async runShell(sessionId: string, command: string, share: boolean): Promise<void> {
    const session = await this.store.require(sessionId)
    const result = await runShellCommand(command, {
      cwd: session.workspaceRoot,
      shell: resolveLoginShell().path
    })
    await this.store.append(sessionId, {
      type: 'session.shell_result',
      command,
      output: result.output,
      exitCode: result.exitCode,
      outcome: result.outcome,
      share
    })
  }

  /**
   * The shared `!` output the agent has not been given yet: everything run since
   * the last message went out.
   *
   * Read off the log rather than kept in memory, so it survives a restart and so
   * the transcript's account of what is still waiting — the same rule, applied
   * to the same events — is the one the service acts on.
   */
  private async pendingShellContext(sessionId: string): Promise<string> {
    const events = await this.store.eventsSince(sessionId, 0)
    const runs: string[] = []
    for (const event of events) {
      if (event.type === 'user.message' || event.type === 'app.message') {
        runs.length = 0
        continue
      }
      if (event.type === 'session.shell_result' && event.share) {
        runs.push(shellContext(event.command, event))
      }
    }
    return runs.join('\n')
  }

  private async startTurn(
    sessionId: string,
    text: string,
    attachments: ImageBlock[] = []
  ): Promise<void> {
    try {
      const run = await this.ensureRun(sessionId)
      // Read late, so a blob is only loaded into memory for a turn that runs.
      const resolved = await this.resolveAttachments(sessionId, attachments)
      await run.prompt(text, resolved)
    } catch (cause) {
      await this.reportError(sessionId, cause as Error)
    }
  }

  // ── Approvals ───────────────────────────────────────────────────

  /**
   * Park a tool call and announce it as a pending approval.
   *
   * The answer arrives as a `user.tool_confirmation` client event — from the
   * user, from the session's permission mode, or from the review flow once the
   * diff has been decided.
   */
  private requestApproval(sessionId: string, request: ApprovalRequest): Promise<ApprovalDecision> {
    const runtime = this.runtimeOrCreate(sessionId)
    // Claimed before anything is awaited: the adapter reports the same call on
    // its own stream a moment later, and whichever arrives second must not
    // duplicate it — or, worse, report it as ungated.
    const fresh = !runtime.announced.has(request.toolUseId)
    runtime.announced.add(request.toolUseId)

    const automatic = this.autoDecisionFor(sessionId, request)
    if (automatic) {
      if (fresh) void this.recordToolUse(sessionId, request, 'allow')
      return Promise.resolve({ result: automatic })
    }

    runtime.pendingApprovals = [...runtime.pendingApprovals, request.toolUseId]
    // Recorded even when the adapter got there first with an ungated call: the
    // harness reports the call as it is made and only then asks whether it may
    // run it, so the second record is what says the call is parked. The fold
    // updates the call it already has rather than adding another.
    void this.recordToolUse(sessionId, request, 'ask')

    return new Promise((resolve) => {
      runtime.approvals.set(request.toolUseId, { name: request.name, resolve })
    })
  }

  /**
   * How this session answers an approval by itself, or null to put it to the
   * user.
   *
   * This is where a permission mode actually takes effect. It has to be here
   * rather than in the window that chose the mode: an approval blocks the
   * harness, and the gated review is raised from the same event, so a decision
   * made in the renderer arrives after the diff it was meant to prevent.
   *
   * Answering here also keeps the review flow consistent for free — an
   * auto-approved call is logged as `allow`, and the review bridge only gates
   * calls logged as `ask`.
   */
  private autoDecisionFor(sessionId: string, request: ApprovalRequest): ConfirmationResult | null {
    const session = this.store.peek(sessionId)
    if (!session) return null
    if (session.permissionMode === 'bypass') return 'allow'
    // "Don't ask again" for this tool, answered earlier in the session.
    if (session.autoApproveTools.includes(request.name)) return 'allow'
    if (session.permissionMode !== 'acceptEdits') return null
    return this.writesAFile(session.harness, request) ? 'allow' : null
  }

  /**
   * Whether a call writes a file, as the harness itself reports it.
   *
   * `intentOf` is the same answer the review flow reads, so accept-edits covers
   * exactly the calls that would have been raised as a diff — and a harness
   * that names its tools differently needs no change here.
   */
  private writesAFile(harnessId: string, request: ApprovalRequest): boolean {
    const descriptor = this.options.harnesses.get(harnessId)
    if (!descriptor) return false
    const input = (request.input as Record<string, unknown>) ?? {}
    return descriptor.intentOf(request.name, input)?.kind === 'write'
  }

  /**
   * `input` is what the call should run with when the user changed it — an
   * edited command, or the answers to a call that asked them something. It
   * goes on the log as well, so the transcript shows what actually ran.
   */
  private async answerApproval(
    sessionId: string,
    toolUseId: string,
    result: ConfirmationResult,
    input?: unknown
  ): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)
    const pending = runtime.approvals.get(toolUseId)
    if (!pending) return

    runtime.approvals.delete(toolUseId)
    runtime.pendingApprovals = runtime.pendingApprovals.filter((id) => id !== toolUseId)
    if (result === 'always_session' || result === 'always_project') {
      await this.rememberAutoApproval(sessionId, pending.name)
    }
    if (input !== undefined) {
      await this.store.append(sessionId, {
        type: 'agent.tool_use_edited',
        toolUseId,
        name: pending.name,
        input
      })
    }
    pending.resolve({ result, input })
  }

  private async rememberAutoApproval(sessionId: string, toolName: string): Promise<void> {
    const session = await this.store.require(sessionId)
    if (session.autoApproveTools.includes(toolName)) return
    await this.store.patch(sessionId, { autoApproveTools: [...session.autoApproveTools, toolName] })
  }

  /** Put a tool call on the log. The caller has already claimed its id. */
  private async recordToolUse(
    sessionId: string,
    request: ApprovalRequest,
    permission: 'allow' | 'ask'
  ): Promise<void> {
    await this.store.append(sessionId, {
      type: 'agent.tool_use',
      toolUseId: request.toolUseId,
      name: request.name,
      input: request.input,
      permission
    })
  }

  // ── Runs ────────────────────────────────────────────────────────

  /** The run for a session, started on first use and reused after that. */
  private async ensureRun(sessionId: string): Promise<HarnessRun> {
    const runtime = this.runtimeOrCreate(sessionId)
    if (runtime.run) return runtime.run
    if (runtime.starting) return runtime.starting

    runtime.starting = this.startRun(sessionId).finally(() => {
      runtime.starting = null
    })
    return runtime.starting
  }

  private async startRun(sessionId: string): Promise<HarnessRun> {
    const session = await this.store.require(sessionId)
    const descriptor = this.options.harnesses.require(session.harness)
    const runtime = this.runtimeOrCreate(sessionId)

    const run = await descriptor.start({
      sessionId,
      workspaceRoot: session.workspaceRoot,
      provider: session.provider || null,
      model: session.model || null,
      thinkingLevel: session.thinkingLevel,
      activeTools: session.activeTools,
      permissionMode: session.permissionMode,
      resumeKey: session.resumeKey,
      tools: this.toolsFor(descriptor),
      systemPrompt: await this.systemPromptFor(session),
      emit: (body) => void this.absorb(sessionId, body),
      emitFrom: (agent, body) => void this.subagents.absorb(sessionId, agent, body),
      stats: (update) => void this.store.patch(sessionId, update),
      confirm: (request) => this.requestApproval(sessionId, request)
    })

    runtime.run = run
    if (run.resumeKey && run.resumeKey !== session.resumeKey) {
      await this.store.patch(sessionId, { resumeKey: run.resumeKey })
    }
    return run
  }

  /**
   * grove's part of the system prompt for one session.
   *
   * Failing to build it must not stop the run: an agent that is not told who
   * else is in the worktree still works, it just works alone.
   */
  private async systemPromptFor(session: StoredSession): Promise<string> {
    const build = this.options.systemPrompt
    if (!build) return ''
    return build(session).catch(() => '')
  }

  /** grove's own tools, for a harness that can host them. */
  private toolsFor(descriptor: { capabilities: { groveTools: boolean } }): GroveTool[] {
    if (!descriptor.capabilities.groveTools) return []
    return this.options.tools()
  }

  /**
   * Open the session standing for an agent a harness is running.
   *
   * It is the session the parent would have got from `spawn_agent`: same
   * worktree, same harness and model, labelled with who started it so the tabs
   * show the two as one family. It has no run of its own — the parent's runtime
   * is doing the work, and everything this session knows arrives through it.
   */
  private async openSubagentSession(
    parentSessionId: string,
    agent: SubagentIdentity
  ): Promise<string> {
    const parent = await this.store.require(parentSessionId)
    const session = await this.createSession({
      workspace: parent.workspaceRoot,
      harness: parent.harness,
      title: agent.title,
      provider: parent.provider,
      model: parent.model,
      labels: { [PARENT_LABEL]: parentSessionId, [SUBAGENT_LABEL]: agent.toolUseId }
    })
    if (agent.description) {
      await this.store.append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: agent.description }]
      })
    }
    return session.id
  }

  /** Fold a harness event into runtime state, then put it on the log. */
  private async absorb(sessionId: string, body: ServerEventBody): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)

    if (body.type === 'agent.tool_use') {
      if (runtime.announced.has(body.toolUseId)) return
      runtime.announced.add(body.toolUseId)
    }
    // The result of a call is the last word of whatever agent that call was
    // running, so the session standing for it stops here rather than sitting in
    // the tabs claiming to work forever.
    if (body.type === 'agent.tool_result') {
      await this.subagents.close(sessionId, body.toolUseId)
    }
    if (body.type === 'session.status_running') {
      runtime.status = 'running'
      runtime.stopReason = undefined
    }
    if (body.type === 'session.status_terminated') {
      runtime.status = 'terminated'
      runtime.run = null
    }

    await this.store.append(sessionId, body)
    if (body.type === 'session.status_idle') await this.finishTurn(sessionId, body.stopReason)
  }

  /** A turn ended: settle the status, then hand over whatever was queued. */
  private async finishTurn(
    sessionId: string,
    stopReason: RuntimeState['stopReason']
  ): Promise<void> {
    const runtime = this.runtimeOrCreate(sessionId)
    runtime.status = 'idle'
    runtime.stopReason = stopReason
    await this.persistResumeKey(sessionId)

    const next = runtime.queued[0]
    if (!next) return
    runtime.queued = runtime.queued.slice(1)
    await this.startTurn(sessionId, next.text, next.attachments)
  }

  /**
   * Keep the stored conversation id in step with the run's.
   *
   * A run does not keep the id it started with: `/clear` drops the conversation
   * and opens a new one. Storing only the id from `startRun` would resume a
   * conversation the harness has already left behind.
   */
  private async persistResumeKey(sessionId: string): Promise<void> {
    const key = this.runtimes.get(sessionId)?.run?.resumeKey
    if (!key) return
    const session = await this.store.require(sessionId)
    if (session.resumeKey === key) return
    await this.store.patch(sessionId, { resumeKey: key })
  }

  private async applyLiveChanges(sessionId: string, changes: SessionUpdate): Promise<void> {
    const run = this.runtimes.get(sessionId)?.run
    if (!run) return
    if (changes.model && run.setModel) {
      await run.setModel(changes.provider ?? null, changes.model).catch(() => {})
    }
    if (changes.thinkingLevel && run.setThinkingLevel) {
      await run.setThinkingLevel(changes.thinkingLevel).catch(() => {})
    }
    // Only plan mode needs the harness told: it withholds tools, which grove's
    // approval layer cannot do on its own. The permissive modes are answered
    // here, so the harness keeps asking and grove keeps logging the calls.
    if (changes.permissionMode && run.setPermissionMode) {
      await run.setPermissionMode(changes.permissionMode).catch(() => {})
    }
  }

  private async stopRun(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.run) return
    const run = runtime.run
    runtime.run = null
    runtime.status = 'idle'
    await run.dispose().catch(() => {})
  }

  /** Stop every run. Called on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((sessionId) => this.stopRun(sessionId)))
  }

  private async reportError(sessionId: string, cause: Error): Promise<void> {
    await this.store.append(sessionId, { type: 'session.error', message: cause.message })
    await this.absorb(sessionId, { type: 'session.status_idle', stopReason: 'error' })
  }

  // ── Attachments and file search ─────────────────────────────────

  /** Store an attachment beside the session and hand back its reference. */
  async putBlob(
    sessionId: string,
    bytes: Uint8Array,
    mediaType: string,
    filename?: string
  ): Promise<BlobDescriptor> {
    await this.store.require(sessionId)
    const directory = join(this.store.dirOf(sessionId), BLOBS_DIR)
    await mkdir(directory, { recursive: true })
    const ref = `${randomUUID()}${extname(filename ?? '')}`
    await writeFile(join(directory, ref), bytes)
    return { ref, mediaType, filename, bytes: bytes.byteLength }
  }

  async readBlob(sessionId: string, ref: string): Promise<Buffer> {
    if (ref.includes('/') || ref.includes('..')) throw new Error(`bad blob reference: ${ref}`)
    return readFile(join(this.store.dirOf(sessionId), BLOBS_DIR, ref))
  }

  /** Fuzzy path search over the session's workspace, for `@` mentions. */
  async searchFiles(sessionId: string, query: string, limit = 20): Promise<FileMatch[]> {
    const session = await this.store.require(sessionId)
    const paths = await files.listAll(session.workspaceRoot)
    const needle = query.toLowerCase()
    const matches: FileMatch[] = []
    for (const path of paths) {
      const score = scorePath(path.toLowerCase(), needle)
      if (score > 0) matches.push({ path, score })
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Completions for the last word of a composer `!` command, from the shell it
   * will run in, in the session's workspace. `line` is the command up to the caret.
   */
  async completeShell(sessionId: string, line: string): Promise<ShellCompletion[]> {
    const session = await this.store.require(sessionId)
    return completeShellLine(line, resolveLoginShell(), session.workspaceRoot, {
      fishCompletionsDir: this.options.shellCompletionsDir
    })
  }

  /** The name of the shell `!` commands run in, e.g. `fish`, for highlighting. */
  shellName(): string {
    return resolveLoginShell().name
  }

  // ── Internals ───────────────────────────────────────────────────

  private resolveHarness(requested: string | undefined): string {
    const wanted = requested ?? this.options.defaultHarness()
    if (wanted) return this.options.harnesses.require(wanted).id
    const first = this.options.harnesses.list()[0]
    if (!first) throw new Error('no agent harness is available')
    return first.id
  }

  private runtimeOrCreate(sessionId: string): Runtime {
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing
    const runtime: Runtime = {
      ...idleRuntime(),
      run: null,
      starting: null,
      approvals: new Map(),
      announced: new Set(),
      messageCount: 0
    }
    this.runtimes.set(sessionId, runtime)
    return runtime
  }

  private runtimeOf(sessionId: string): RuntimeState {
    return this.runtimes.get(sessionId) ?? idleRuntime()
  }

  private isLive(sessionId: string): boolean {
    return (
      this.runtimes.get(sessionId)?.run !== undefined && this.runtimes.get(sessionId)?.run !== null
    )
  }

  private snapshot(session: StoredSession): SessionSnapshot {
    const runtime = this.runtimes.get(session.id)
    return SessionStore.snapshotOf(
      session,
      this.isLive(session.id),
      runtime ?? idleRuntime(),
      runtime?.messageCount ?? 0
    )
  }

  /** Start publishing the store's events to the renderer; returns the inverse. */
  watch(): () => void {
    return this.store.subscribe((event) => this.options.publish(event))
  }

  /** Follow one session's events, for callers that only care about that one. */
  observe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
    return this.store.subscribe((event) => {
      if (event.sessionId === sessionId) onEvent(event)
    })
  }

  /** Every harness's models at once, for the plugin API's flat listing. */
  async allModels(): Promise<{ provider: string; models: { id: string }[] }[]> {
    const offerings = await Promise.all(
      this.options.harnesses.list().map(async (descriptor) => {
        const offering = await descriptor.offering().catch(() => null)
        if (!offering) return []
        return groupRoutesByProvider(offering.models).map(([provider, ids]) => ({
          provider: `${descriptor.id}/${provider}`,
          models: ids.map((id) => ({ id }))
        }))
      })
    )
    return offerings.flat()
  }

  /** Queued messages for a session, for callers that only need the queue. */
  queueOf(sessionId: string): QueuedMessage[] {
    return this.runtimes.get(sessionId)?.queued ?? []
  }
}

/** One of grove's tools as the renderer's catalog describes a tool. */
function toolInfoOf(tool: GroveTool): ToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    summary: tool.summary,
    policy: tool.policy,
    // Two calls to the same grove tool in one batch would race on the channel
    // or start two sessions; none of them is worth parallelising.
    parallelSafe: false,
    display: tool.display,
    inputSchema: tool.inputSchema
  }
}

function textOf(event: Extract<ClientEventBody, { type: 'user.message' | 'app.message' }>): string {
  if (event.type === 'app.message') {
    // A message from another agent is read as being from that agent; everything
    // else grove sends is read as what it is.
    if (event.from) return `[Message from ${event.from}]\n${event.text}`
    return `[${event.label}]\n${event.text}`
  }
  return event.content
    .map(blockText)
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * One `!` command as the model reads it.
 *
 * Command and output are tagged rather than pasted in raw, so the model can tell
 * what the user ran from what the user is saying.
 */
/**
 * Model entries flattened back to one list of ids per provider.
 *
 * The picker wants a model and the routes that serve it; the plugin API wants
 * the older provider → ids listing, which is this same data read the other way
 * round.
 */
function groupRoutesByProvider(models: ModelEntry[]): [string, string[]][] {
  const byProvider = new Map<string, string[]>()
  for (const entry of models) {
    for (const route of entry.routes) {
      const ids = byProvider.get(route.provider)
      if (ids) ids.push(route.id)
      else byProvider.set(route.provider, [route.id])
    }
  }
  return [...byProvider.entries()]
}

/** Shell output that was waiting, put in front of the message it rides along with. */
function withPendingShell(pending: string, text: string): string {
  if (pending.length === 0) return text
  return `${pending}\n${text}`
}

function shellContext(command: string, result: ShellResult): string {
  const lines = [`<shell-command outcome="${result.outcome}">`, `$ ${command}`]
  if (result.output.length > 0) lines.push(result.output)
  lines.push('</shell-command>')
  return lines.join('\n')
}

/**
 * One content block as the model reads it. Attached file slices are tagged with
 * where they came from, so the model can cite lines without reading the file.
 */
function blockText(block: UserContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type !== 'file') return ''
  const range = `${block.startLine}-${block.endLine}`
  return `<file path="${block.path}" lines="${range}">\n${block.text}\n</file>`
}

/**
 * Subsequence match with a bonus for contiguity and for hits in the file name,
 * which is what makes `agpane` find `AgentPane.svelte` above `agents/pane.ts`.
 */
function scorePath(path: string, needle: string): number {
  if (needle.length === 0) return 1
  let score = 0
  let cursor = 0
  let previous = -1
  for (const character of needle) {
    const index = path.indexOf(character, cursor)
    if (index < 0) return 0
    score += index === previous + 1 ? 3 : 1
    previous = index
    cursor = index + 1
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.includes(needle)) score += 10
  return score
}

/** Thinking levels every harness understands, in order. */
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
