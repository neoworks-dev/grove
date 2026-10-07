/**
 * Event log → render model.
 *
 * The whole UI is a fold over the transcript: the same function handles replayed history and live
 * SSE frames, so a reconnect cannot produce a different view than a fresh load. Plain data and
 * in-place mutation — the caller wraps the state in `$state` to make it reactive.
 *
 * Branching is modelled exactly as the server models it. Every item records the event that created
 * it and that event's parent, so the transcript is a tree and what you see is the path from the
 * head back to the root. Nothing is discarded when a branch is abandoned, which is what lets the
 * tree panel put one back.
 */

import { commandLine } from './types'
import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AgentTask,
  FileBlock,
  HeldMessage,
  IdleReason,
  ImageBlock,
  SessionEvent,
  SessionNote,
  SessionStatus,
  SpawnTarget,
  ToolCallUpdate,
  ToolPermission,
  UiNode,
  UiSlot,
  UserContentBlock
} from './types'

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error' | 'denied'

export interface UserItem {
  kind: 'user'
  seq: number
  eventId: string
  text: string
  attachments: ImageBlock[]
  /** File slices sent with the message; shown as chips, not inlined in the bubble. */
  references: FileBlock[]
  /**
   * Written while the agent was busy and not yet taken up: steered or queued, it
   * reaches the model with the next message the agent starts.
   */
  pending: boolean
  /** A slash command, read back as the line typed; it ran as the command, not as this text. */
  command?: boolean
}

export interface AgentItem {
  kind: 'agent'
  seq: number
  eventId: string
  /** The harness's id for the message, when it gives one. */
  messageId: string | null
  thinking: string
  text: string
  streaming: boolean
}

export interface AppItem {
  kind: 'app'
  seq: number
  eventId: string
  label: string
  text: string
  /** The agent that sent it, when it came from one rather than from grove itself. */
  from?: string
}

/** One piece of what a tool call carries: text or an image, a file diff, a terminal. */
export type ToolContent = NonNullable<ToolCallUpdate['content']>[number]

export interface ToolItem {
  kind: 'tool'
  seq: number
  eventId: string
  toolUseId: string
  /** The tool's name, bare for grove's own tools whatever prefix the harness gave them. */
  name: string
  /** How the harness describes this call: "Read src/app.ts", "npm test". */
  title: string
  /** ACP's kind of call — read, edit, execute, search, … — which picks how it is drawn. */
  toolKind: string
  input: unknown
  /** Set when the user replaced the model's arguments before approving. */
  editedInput: unknown
  permission: ToolPermission
  status: ToolStatus
  progress: string
  result: string
  /**
   * The result's text as the tool returned it, before the harness dressed it
   * for display — Claude Code fences a failed call's text — or '' when the
   * harness reported none.
   */
  rawResult: string
  /** Images the tool returned, shown under its row. */
  images: ImageBlock[]
  /** Diffs and terminals the call carries, as the harness reported them. */
  content: ToolContent[]
  /** Files the call touches, for following along in the editor. */
  locations: { path: string; line?: number | null }[]
  /**
   * What a spawn said it would run on before it ran, for its approval to show
   * and let the user change. Null for any other call.
   */
  spawn: SpawnTarget | null
}

export interface ShellItem {
  kind: 'shell'
  seq: number
  eventId: string
  /** The id its live output streams under: the `user.shell` event that started it. */
  shellId: string | null
  /** Still going: no result yet. */
  running: boolean
  /** It was sent to the background; a shared one went to the agent when it exited. */
  background: boolean
  command: string
  output: string
  exitCode: number
  outcome: string
  shared: boolean
  /**
   * Has the agent been given this yet?
   *
   * Shared output rides along with the next message rather than being sent on
   * its own, so between running the command and writing that message it is
   * waiting — which the row says, since nothing else would.
   */
  delivered: boolean
}

export interface NoticeItem {
  kind: 'notice'
  seq: number
  eventId: string
  tone: 'info' | 'error'
  text: string
  /** The turn ended in the model refusing it; the notice offers to reword the prompt. */
  refusal?: boolean
}

export type CompactionStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * The harness shrinking its context: one row from the moment it starts, which
 * every later report on the same compaction updates in place, as ACP has it.
 */
export interface CompactionItem {
  kind: 'compaction'
  seq: number
  eventId: string
  compactionId: string
  status: CompactionStatus
  /** `/compact` asked for it, or the harness ran out of room; null when not said. */
  trigger: 'manual' | 'automatic' | null
  /** The context before and after, in tokens, when the harness reports them. */
  tokensBefore: number | null
  tokensAfter: number | null
  /** What the conversation was reduced to, when the harness shows it. */
  summary: string
  error: string
}

/** An extension's own UI. `slot` decides whether it belongs in the conversation or beside it. */
export interface SurfaceItem {
  kind: 'surface'
  seq: number
  eventId: string
  surfaceId: string
  slot: UiSlot
  view: UiNode
}

export type TranscriptItem =
  UserItem | AppItem | AgentItem | ToolItem | ShellItem | NoticeItem | CompactionItem | SurfaceItem

export interface TranscriptState {
  /** Every item ever created, in seq order — including branches not currently in play. */
  items: TranscriptItem[]
  parentOf: Map<number, number>
  /** The seq the conversation continues from; 0 is the root. */
  head: number
  activeSeqs: Set<number>
  status: SessionStatus
  stopReason: IdleReason | null
  lastSeq: number
  /** The notes list, as last saved. It belongs to the session, not to a branch. */
  notes: SessionNote[]
  /** The harness's own plan, as last reported. */
  tasks: AgentTask[]
  /** Agent messages held off this sleeping session until the user decides (wakeGate.ts). */
  held: HeldMessage[]
  /**
   * The seq the latest turn started at: its `session.status_running`. A message
   * steered into a turn lands after it, a message that started one before it,
   * which is how the pane tells the two apart.
   */
  turnStartSeq: number
}

const ROOT = 0

export function createTranscript(): TranscriptState {
  return {
    items: [],
    parentOf: new Map(),
    head: ROOT,
    activeSeqs: new Set(),
    status: 'idle',
    stopReason: null,
    lastSeq: 0,
    notes: [],
    tasks: [],
    held: [],
    turnStartSeq: ROOT
  }
}

/**
 * What to render: the path from the head back to the root, in transcript order.
 *
 * Panel surfaces are held in the same list — one array keeps the fold and its reactivity simple —
 * but they are not part of the conversation, so they are not part of this. Nor is a message the
 * agent has not taken up yet: it waits above the composer (`waitingMessages`) and joins the
 * conversation where the agent takes it.
 */
export function visibleItems(state: TranscriptState): TranscriptItem[] {
  return active(state).filter((item) => !isPanel(item) && !isWaiting(item))
}

/** Messages written mid-turn that the agent has not taken up yet, oldest first. */
export function waitingMessages(state: TranscriptState): UserItem[] {
  return active(state).filter((item): item is UserItem => isWaiting(item))
}

/** Whether an item is a panel surface, which sits beside the conversation rather than in it. */
function isPanel(item: TranscriptItem): boolean {
  return item.kind === 'surface' && item.slot === 'panel'
}

/** Whether an item is a user message still waiting for the agent to take it up. */
function isWaiting(item: TranscriptItem): boolean {
  return item.kind === 'user' && item.pending
}

function active(state: TranscriptState): TranscriptItem[] {
  return state.items.filter((item) => state.activeSeqs.has(item.seq))
}

// How an inter-agent message was labelled before `app.message` carried its
// sender. Kept so transcripts recorded then still read as messages.
const AGENT_LABEL_PREFIX = 'Message from '

/** The agent an app message came from, or null when grove itself sent it. */
export function senderOf(item: AppItem): string | null {
  if (item.from) return item.from
  if (item.label.startsWith(AGENT_LABEL_PREFIX)) {
    return item.label.slice(AGENT_LABEL_PREFIX.length)
  }
  return null
}

/**
 * The agent id inside a sender, as `signatureOf` writes it: `Echo (155a4e)`.
 *
 * The id is what identifies the session; the title in front of it is only there
 * to be read. A sender grove wrote by hand has none, and is not clickable.
 */
export function agentIdIn(sender: string): string | null {
  const match = /\(([^()]+)\)\s*$/.exec(sender.trim())
  if (!match) return null
  return match[1]
}

/**
 * Is this event something a person would call new?
 *
 * A session running in the background produces dozens of events a turn —
 * statuses, tool calls, one per streamed fragment — and counting them all turned
 * the unread badge into an event counter: "31 new" for a single answer. A turn
 * the agent finished is one answer, and a message another agent sent is one
 * message; nothing else counts.
 */
export function isUnreadEvent(event: SessionEvent): boolean {
  if (event.type === 'session.status_idle') return event.stopReason === 'end_turn'
  if (event.type === 'app.message') return true
  return false
}

/** The tool calls the agent is blocked on. */
export function pendingApprovals(state: TranscriptState): ToolItem[] {
  return visibleItems(state).filter(
    (item): item is ToolItem => item.kind === 'tool' && item.status === 'pending'
  )
}

/**
 * Whether the turn is out on a tool call, running or waiting on an approval,
 * rather than with the model: what the agent is doing is then the call's to
 * show, not the working bar's.
 */
export function toolCallOut(state: TranscriptState): boolean {
  return visibleItems(state).some(
    (item) => item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')
  )
}

/** Whether the harness is compacting its context, which the compaction's own row shows. */
export function compacting(state: TranscriptState): boolean {
  return visibleItems(state).some((item) => item.kind === 'compaction' && item.status === 'running')
}

/** The seq the turn in flight started at, or null when no turn is running. */
export function turnInFlightSince(state: TranscriptState): number | null {
  if (state.status !== 'running') {
    return null
  }
  return state.turnStartSeq
}

export function applyEvent(state: TranscriptState, event: SessionEvent): void {
  // Replay and live stream overlap by design; the seq guard makes the fold idempotent.
  if (event.seq <= state.lastSeq) {
    return
  }
  state.lastSeq = event.seq

  if (event.type === 'session.branched') {
    state.head = event.fromSeq
    recomputeActive(state)
    return
  }
  // A cleared conversation is a branch from the root: nothing before it is in
  // play any more, but the log still holds it, so the tree panel can go back.
  if (event.type === 'session_changed') {
    state.head = ROOT
    recomputeActive(state)
    return
  }
  // The request to branch is what moves the head, so it belongs to no branch itself.
  if (event.type === 'user.branch') {
    return
  }
  // The lists above the composer are the session's, whichever branch is in
  // play, so they are not steps in the conversation either.
  if (event.type === 'session.notes') {
    state.notes = event.notes
    return
  }
  if (event.type === 'update' && event.update.sessionUpdate === 'plan') {
    state.tasks = tasksOf(event.update.entries)
    return
  }
  // A held message waits above the composer until the user decides on it; it
  // only enters the conversation as the message sent once they do.
  if (event.type === 'app.held_message') {
    state.held = [...state.held, heldMessageOf(event)]
    return
  }
  if (event.type === 'user.decide_held_message') {
    state.held = state.held.filter((held) => held.heldId !== event.heldId)
    return
  }

  state.parentOf.set(event.seq, state.head)
  state.head = event.seq
  state.activeSeqs.add(event.seq)

  applyStatus(state, event)
  applyMessage(state, event)
  applyTool(state, event)
  applyShell(state, event)
  applyNotice(state, event)
  applyCompaction(state, event)
  applySurface(state, event)
}

/** Panel surfaces on the active branch — what sits beside the conversation rather than in it. */
export function visiblePanels(state: TranscriptState): SurfaceItem[] {
  return active(state).filter(
    (item): item is SurfaceItem => item.kind === 'surface' && item.slot === 'panel'
  )
}

function recomputeActive(state: TranscriptState): void {
  const path = new Set<number>()

  let current = state.head
  while (current !== ROOT && !path.has(current)) {
    path.add(current)
    current = state.parentOf.get(current) ?? ROOT
  }
  state.activeSeqs = path
}

function applyStatus(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'session.status_running') {
    state.status = 'running'
    state.turnStartSeq = event.seq
    state.stopReason = null
    // The turn's prompt carries whatever was waiting (after an interrupt, the
    // service restarts with the steers the harness dropped), so those messages
    // are sent now, not when the first reply text arrives seconds later.
    markUserMessagesTaken(state)
  }
  if (event.type === 'session.status_idle') {
    state.status = 'idle'
    state.stopReason = event.stopReason
    closeOpenAgentItem(state)
    endCompactions(state)
  }
  if (event.type === 'session.status_terminated') {
    state.status = 'terminated'
    closeOpenAgentItem(state)
    endCompactions(state)
  }
}

/**
 * A message the agent starts is a new request to the model, and that request
 * carries everything written to it so far: nothing is waiting any more. The
 * waiting messages move to the end of the list, so they read where the agent
 * took them up rather than where they were typed.
 */
function markUserMessagesTaken(state: TranscriptState): void {
  const taken = state.items.filter((item): item is UserItem => isWaiting(item))
  if (taken.length === 0) {
    return
  }
  state.items = state.items.filter((item) => !isWaiting(item))
  for (const item of taken) {
    item.pending = false
    state.items.push(item)
  }
}

function applyMessage(state: TranscriptState, event: SessionEvent): void {
  // Both carry whatever shell output was waiting: the service prepends it to
  // anything it delivers to the harness, whoever wrote it.
  if (event.type === 'user.message' || event.type === 'app.message') {
    markShellDelivered(state)
  }
  if (event.type === 'user.message') {
    state.items.push({
      kind: 'user',
      seq: event.seq,
      eventId: event.id,
      text: textOf(event.content),
      attachments: event.content.filter((block): block is ImageBlock => block.type === 'image'),
      references: event.content.filter((block): block is FileBlock => block.type === 'file'),
      pending: state.status === 'running'
    })
  }
  // A command reads back as the line that was typed, since that is what the
  // harness was asked to run.
  if (event.type === 'user.command') {
    state.items.push({
      kind: 'user',
      seq: event.seq,
      eventId: event.id,
      text: commandLine(event.name, event.args),
      attachments: [],
      references: [],
      pending: false,
      command: true
    })
  }
  if (event.type === 'app.message') {
    state.items.push({
      kind: 'app',
      seq: event.seq,
      eventId: event.id,
      label: event.label,
      text: event.text,
      from: event.from
    })
  }
  if (event.type === 'user.unqueue') {
    dropModelVisibleMessage(state, event.messageId)
  }
  if (event.type !== 'update') {
    return
  }
  const update = event.update
  if (update.sessionUpdate === 'agent_message_chunk') {
    openAgentItem(state, event, update.messageId ?? null).text += chunkText(update.content)
  }
  if (update.sessionUpdate === 'agent_thought_chunk') {
    openAgentItem(state, event, update.messageId ?? null).thinking += chunkText(update.content)
  }
}

function applyTool(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'update') {
    const update = event.update
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      applyToolUpdate(state, event, update)
    }
  }
  // A call held for a decision. The harness has usually reported it already; a
  // tool grove serves may be asked about before it has.
  if (event.type === 'permission') {
    const tool = toolFor(state, event, event.request.toolCall)
    tool.permission = 'ask'
    tool.status = 'pending'
  }
  if (event.type === 'user.tool_confirmation') {
    applyConfirmation(state, event.toolUseId, event.result, event.input)
  }
}

/** Fold a report on a tool call into its row, creating the row on first sight. */
function applyToolUpdate(
  state: TranscriptState,
  event: SessionEvent,
  update: ToolCallUpdate
): void {
  const tool = toolFor(state, event, update)
  // A call parked on a decision stays parked until it is decided: Claude Code
  // reports a slow MCP call as in progress every 30 seconds, approved or not.
  const decided = tool.status !== 'pending' && tool.status !== 'denied'
  if (update.status === 'in_progress' && decided) tool.status = 'running'
  if (update.status === 'completed' || update.status === 'failed') {
    tool.result = resultText(update)
    tool.rawResult = rawOutputText(update.rawOutput)
    tool.images = imagesOf(update.content ?? [])
    tool.progress = ''
    tool.status = update.status === 'failed' ? 'error' : 'ok'
  }
}

/**
 * The row for a call, with whatever this report adds folded in. A call is
 * refined as its input streams in, so every field the report carries replaces
 * what the row had.
 */
function toolFor(state: TranscriptState, event: SessionEvent, update: ToolCallUpdate): ToolItem {
  let tool = findTool(state, update.toolCallId)
  if (!tool) {
    closeOpenAgentItem(state)
    state.items.push({
      kind: 'tool',
      seq: event.seq,
      eventId: event.id,
      toolUseId: update.toolCallId,
      name: '',
      title: '',
      toolKind: 'other',
      input: {},
      editedInput: undefined,
      permission: 'allow',
      status: 'running',
      progress: '',
      result: '',
      rawResult: '',
      images: [],
      content: [],
      locations: [],
      spawn: null
    })
    tool = state.items[state.items.length - 1] as ToolItem
  }
  const name = toolNameOf(update)
  if (name) tool.name = name
  if (update.title) tool.title = update.title
  if (update.kind) tool.toolKind = update.kind
  if (update.rawInput !== undefined) tool.input = update.rawInput
  if (update.content) tool.content = update.content.filter((entry) => entry.type !== 'content')
  if (update.locations) tool.locations = update.locations
  const spawn = spawnOf(update._meta)
  if (spawn) tool.spawn = spawn
  return tool
}

/** What `spawn_agent` attached under `_meta.grove.spawn`, or null when it attached nothing. */
function spawnOf(meta: { [key: string]: unknown } | null | undefined): SpawnTarget | null {
  const grove = meta?.grove as { spawn?: unknown } | undefined
  const spawn = grove?.spawn as SpawnTarget | undefined
  if (!spawn || typeof spawn !== 'object') return null
  if (typeof spawn.modelIsDefault !== 'boolean') return null
  return spawn
}

// How harnesses spell a tool grove serves: Claude and Codex prefix the server,
// pi's MCP adapter joins it with an underscore.
const GROVE_TOOL_PREFIXES = ['mcp__grove__', 'grove__', 'grove.', 'grove_']

/**
 * A tool's name as the transcript knows it: grove's own tools bare, whatever
 * prefix the harness gave them, so their display settings apply.
 */
export function toolNameOf(update: {
  name?: string | null
  _meta?: { [key: string]: unknown } | null
}): string | null {
  let name = update.name ?? null
  const claudeCode = update._meta?.claudeCode as { toolName?: unknown } | undefined
  if (!name && typeof claudeCode?.toolName === 'string') name = claudeCode.toolName
  if (!name) return null
  for (const prefix of GROVE_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/** A finished call's text: its text content, or what it reported raw. */
function resultText(update: ToolCallUpdate): string {
  const text = (update.content ?? [])
    .map((entry) => {
      if (entry.type !== 'content') return ''
      return chunkText((entry as { content: AcpContentBlock }).content)
    })
    .filter((part) => part.length > 0)
    .join('\n')
  if (text.length > 0) return text
  if (typeof update.rawOutput === 'string') return update.rawOutput
  return ''
}

/**
 * The text of what a call reported raw: a string as it is, text blocks joined,
 * '' for anything else — a harness's structured output is not text to show.
 */
function rawOutputText(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput
  if (!Array.isArray(rawOutput)) return ''
  return rawOutput
    .map((block: { type?: unknown; text?: unknown }) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return ''
      return block.text
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

// The scheme main stores a tool's images under, in place of their bytes.
const BLOB_URI_SCHEME = 'grove-blob:'

/** The images a call returned, as the session blobs main moved them into. */
function imagesOf(content: ToolContent[]): ImageBlock[] {
  const images: ImageBlock[] = []
  for (const entry of content) {
    if (entry.type !== 'content') continue
    const block = (entry as { content: AcpContentBlock }).content
    if (block.type !== 'image' || !block.uri?.startsWith(BLOB_URI_SCHEME)) continue
    const ref = block.uri.slice(BLOB_URI_SCHEME.length)
    images.push({ type: 'image', ref, mediaType: block.mimeType })
  }
  return images
}

function chunkText(block: AcpContentBlock): string {
  if (block.type !== 'text') return ''
  return block.text
}

function tasksOf(
  entries: Extract<AcpSessionUpdate, { sessionUpdate: 'plan' }>['entries']
): AgentTask[] {
  return entries.map((entry, index) => ({
    id: String(index + 1),
    text: entry.content,
    status: entry.status
  }))
}

/**
 * A `!` command shows from the moment it is submitted, running, and its result
 * fills the same row in. A result whose start is not on the log stands alone.
 */
function applyShell(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'user.shell') {
    state.items.push({
      kind: 'shell',
      seq: event.seq,
      eventId: event.id,
      shellId: event.id,
      running: true,
      background: false,
      command: event.command,
      output: '',
      exitCode: 0,
      outcome: '',
      shared: event.share === true,
      delivered: false
    })
    return
  }
  if (event.type !== 'session.shell_result') {
    return
  }
  const background = event.background === true
  const started = runningShellItem(state, event.shellId, event.command)
  if (started) {
    started.running = false
    started.background = background
    started.output = event.output
    started.exitCode = event.exitCode
    started.outcome = event.outcome
    started.delivered = background && started.shared
    return
  }
  state.items.push({
    kind: 'shell',
    seq: event.seq,
    eventId: event.id,
    shellId: event.shellId ?? null,
    running: false,
    background,
    command: event.command,
    output: event.output,
    exitCode: event.exitCode,
    outcome: event.outcome,
    shared: event.share,
    delivered: background && event.share
  })
}

/**
 * The row a result belongs to: the one started by its `user.shell` event, or —
 * on logs from before results named it — the oldest running row for the same
 * command line.
 */
function runningShellItem(
  state: TranscriptState,
  shellId: string | undefined,
  command: string
): ShellItem | undefined {
  for (const item of state.items) {
    if (item.kind !== 'shell' || !item.running) continue
    if (shellId !== undefined && item.shellId === shellId) return item
    if (shellId === undefined && item.command === command) return item
  }
  return undefined
}

/**
 * Hand every shared command above this point to the agent.
 *
 * Grove buffers shared output and prepends it to the next message, so a message
 * is exactly the moment the waiting ends — for all of them at once.
 */
function markShellDelivered(state: TranscriptState): void {
  for (const item of state.items) {
    // A command still running has nothing to hand over yet.
    if (item.kind === 'shell' && item.shared && !item.running) item.delivered = true
  }
}

/**
 * A surface is upserted by id: the newest write wins, and a null view removes it.
 *
 * Both slots land in `items`, which is what keeps the fold reactive — a `Map` beside it would not
 * be, since Svelte's state proxy does not reach into one. `visibleItems` and `visiblePanels` then
 * take the two views of the one list.
 *
 * A replacement is a new event at a new seq, so a surface moves to where the conversation is now
 * rather than staying where its first version was.
 */
function applySurface(state: TranscriptState, event: SessionEvent): void {
  if (event.type !== 'ui.surface') {
    return
  }

  removeSurface(state, event.surfaceId)
  if (event.view === null) {
    return
  }

  // `ui.surface` is two shapes discriminated by `view`, but the discriminant sits
  // behind an intersection with the event envelope and this TypeScript will not
  // narrow through it — so name the set shape once, having just ruled out the
  // clearing one.
  const set = event as { surfaceId: string; slot: UiSlot; view: UiNode }
  state.items.push({
    kind: 'surface',
    seq: event.seq,
    eventId: event.id,
    surfaceId: set.surfaceId,
    slot: set.slot,
    view: set.view
  })
}

function removeSurface(state: TranscriptState, surfaceId: string): void {
  const index = state.items.findIndex(
    (item) => item.kind === 'surface' && item.surfaceId === surfaceId
  )
  if (index >= 0) {
    state.items.splice(index, 1)
  }
}

function applyNotice(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'session.error') {
    pushNotice(state, event, 'error', event.message)
  }
  if (event.type === 'session.notice') {
    pushNotice(state, event, 'info', event.message)
    if (event.refusal === true) markRefusal(state)
  }
  if (event.type === 'session.status_terminated') {
    pushNotice(state, event, 'info', `Session terminated: ${event.reason}`)
  }
  if (event.type === 'user.interrupt') {
    pushNotice(state, event, 'info', 'Interrupted.')
  }
  if (event.type === 'update' && event.update.sessionUpdate === 'notice') {
    pushNotice(state, event, 'info', noticeText(event.update.title, event.update.description))
  }
  if (event.type === 'session.forked') {
    pushNotice(state, event, 'info', `Forked into a new session at seq ${event.afterSeq}.`)
  }
}

type CompactionUpdate = Extract<AcpSessionUpdate, { sessionUpdate: 'compaction_update' }>

/**
 * Compaction as ACP reports it: the first update for an id places the row, and
 * later ones patch it in place. Summary chunks stream into it meanwhile.
 */
function applyCompaction(state: TranscriptState, event: SessionEvent): void {
  if (event.type !== 'update') {
    return
  }
  const update = event.update
  if (update.sessionUpdate === 'compaction_update') {
    patchCompaction(compactionFor(state, event, update.compactionId), update)
  }
  if (update.sessionUpdate === 'compaction_summary_chunk') {
    const compaction = findCompaction(state, update.compactionId)
    if (compaction) compaction.summary += chunkText(update.content)
  }
}

/**
 * Folds an update into its row. `summary`, `error` and `_meta` are patches:
 * left alone when absent, cleared by `null`. Claude sends a compaction's
 * outcome twice, the second time only to add the token counts.
 */
function patchCompaction(compaction: CompactionItem, update: CompactionUpdate): void {
  const status = compactionStatusOf(update.status)
  if (status) compaction.status = status
  if (update.summary !== undefined) {
    compaction.summary = textOfBlocks(update.summary)
  }
  if (update.error !== undefined) {
    compaction.error = ''
    if (update.error !== null) compaction.error = update.error
  }
  if (update._meta !== undefined) {
    applyCompactionFacts(compaction, update._meta)
  }
}

/** The row's status for an ACP one; null for a status this fold does not know. */
function compactionStatusOf(status: string): CompactionStatus | null {
  if (status === 'in_progress') return 'running'
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status
  return null
}

function textOfBlocks(blocks: AcpContentBlock[] | null): string {
  if (blocks === null) return ''
  return blocks.map(chunkText).join('')
}

/**
 * The facts claude-agent-acp, codex-acp and pi attach under
 * `_meta.contextCompaction`. `_meta` replaces what was there, so a fact it
 * leaves out is gone.
 */
function applyCompactionFacts(
  compaction: CompactionItem,
  meta: { [key: string]: unknown } | null
): void {
  const facts = recordOf(meta?.contextCompaction)
  compaction.trigger = triggerOf(facts.trigger)
  compaction.tokensBefore = tokenCountOf(facts.preTokens)
  compaction.tokensAfter = tokenCountOf(facts.postTokens)
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}

function triggerOf(value: unknown): CompactionItem['trigger'] {
  if (value === 'manual' || value === 'automatic') return value
  return null
}

function tokenCountOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/** The row for a compaction, created on first sight. */
function compactionFor(
  state: TranscriptState,
  event: SessionEvent,
  compactionId: string
): CompactionItem {
  const existing = findCompaction(state, compactionId)
  if (existing) {
    return existing
  }
  closeOpenAgentItem(state)
  const compaction: CompactionItem = {
    kind: 'compaction',
    seq: event.seq,
    eventId: event.id,
    compactionId,
    status: 'running',
    trigger: null,
    tokensBefore: null,
    tokensAfter: null,
    summary: '',
    error: ''
  }
  state.items.push(compaction)
  return compaction
}

/** Searches the branch in play, as `findTool` does. */
function findCompaction(state: TranscriptState, compactionId: string): CompactionItem | undefined {
  return active(state).findLast(
    (item): item is CompactionItem =>
      item.kind === 'compaction' && item.compactionId === compactionId
  )
}

/**
 * A turn that ended took its compaction with it. The harness should have said
 * so; one that crashed never will, and the row must not spin on forever.
 */
function endCompactions(state: TranscriptState): void {
  for (const item of active(state)) {
    if (item.kind === 'compaction' && item.status === 'running') item.status = 'cancelled'
  }
}

function pushNotice(
  state: TranscriptState,
  event: SessionEvent,
  tone: 'info' | 'error',
  text: string
): void {
  state.items.push({ kind: 'notice', seq: event.seq, eventId: event.id, tone, text })
}

/** The notice just pushed is a refusal. */
function markRefusal(state: TranscriptState): void {
  const notice = state.items[state.items.length - 1]
  if (notice?.kind === 'notice') notice.refusal = true
}

function noticeText(title: string, description: string | null | undefined): string {
  if (!description) return title
  return `${title}: ${description}`
}

function textOf(content: UserContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function dropModelVisibleMessage(state: TranscriptState, eventId: string): void {
  const index = state.items.findIndex(
    (item) => (item.kind === 'user' || item.kind === 'app') && item.eventId === eventId
  )
  if (index >= 0) {
    state.items.splice(index, 1)
  }
}

function applyConfirmation(
  state: TranscriptState,
  toolUseId: string,
  result: string,
  input: unknown
): void {
  const tool = findTool(state, toolUseId)
  if (!tool) {
    return
  }
  if (input !== undefined) {
    tool.editedInput = input
  }
  if (result === 'deny') {
    tool.status = 'denied'
    return
  }
  tool.status = 'running'
}

/** Searches the branch in play; an identically-named call on an abandoned one is not this one. */
function findTool(state: TranscriptState, toolUseId: string): ToolItem | undefined {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (
      item &&
      state.activeSeqs.has(item.seq) &&
      item.kind === 'tool' &&
      item.toolUseId === toolUseId
    ) {
      return item
    }
  }
  return undefined
}

/** The last item on the branch in play; a waiting message is not in the conversation yet. */
function lastActiveItem(state: TranscriptState): TranscriptItem | undefined {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (item !== undefined && state.activeSeqs.has(item.seq) && !isWaiting(item)) {
      return item
    }
  }
  return undefined
}

/**
 * The agent block being streamed into, opened when the agent starts saying
 * something — after anything else happened, or under a new message id. A new
 * message is a new request to the model, which took everything written so far.
 */
function openAgentItem(
  state: TranscriptState,
  event: SessionEvent,
  messageId: string | null
): AgentItem {
  const last = lastActiveItem(state)
  if (last && last.kind === 'agent' && last.streaming && sameMessage(last, messageId)) {
    if (messageId !== null) last.messageId = messageId
    return last
  }
  closeOpenAgentItem(state)
  markUserMessagesTaken(state)

  state.items.push({
    kind: 'agent',
    seq: event.seq,
    eventId: event.id,
    messageId,
    thinking: '',
    text: '',
    streaming: true
  })
  return state.items[state.items.length - 1] as AgentItem
}

/** Whether a chunk continues a block: it does unless both carry ids and they differ. */
function sameMessage(item: AgentItem, messageId: string | null): boolean {
  if (messageId === null || item.messageId === null) return true
  return item.messageId === messageId
}

function closeOpenAgentItem(state: TranscriptState): void {
  const last = lastActiveItem(state)
  if (last && last.kind === 'agent') {
    last.streaming = false
  }
}

/** The held message an event records, without the event's envelope. */
function heldMessageOf(event: Extract<SessionEvent, { type: 'app.held_message' }>): HeldMessage {
  return {
    heldId: event.heldId,
    from: event.from,
    fromSessionId: event.fromSessionId,
    text: event.text,
    idleSince: event.idleSince,
    contextTokens: event.contextTokens,
    wakeCost: event.wakeCost,
    canCompact: event.canCompact
  }
}
