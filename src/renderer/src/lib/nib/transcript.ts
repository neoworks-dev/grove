// Vendored from nib (web/src/renderer/lib/transcript.ts), reformatted to grove's
// style. One divergence, marked at the site: a cast in applySurface that grove's
// TypeScript needs and nib's does not. tests/nibTranscript.test.ts guards a
// re-vendor.
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

import type {
  ContentBlock,
  IdleReason,
  ImageBlock,
  SessionEvent,
  SessionStatus,
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
}

export interface AgentItem {
  kind: 'agent'
  seq: number
  eventId: string
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
}

export interface ToolItem {
  kind: 'tool'
  seq: number
  eventId: string
  toolUseId: string
  name: string
  input: unknown
  /** Set when the user replaced the model's arguments before approving. */
  editedInput: unknown
  permission: ToolPermission
  status: ToolStatus
  progress: string
  result: string
}

export interface ShellItem {
  kind: 'shell'
  seq: number
  eventId: string
  command: string
  output: string
  exitCode: number
  outcome: string
  shared: boolean
}

export interface NoticeItem {
  kind: 'notice'
  seq: number
  eventId: string
  tone: 'info' | 'error'
  text: string
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
  | UserItem
  | AppItem
  | AgentItem
  | ToolItem
  | ShellItem
  | NoticeItem
  | SurfaceItem

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
    lastSeq: 0
  }
}

/**
 * What to render: the path from the head back to the root, in transcript order.
 *
 * Panel surfaces are held in the same list — one array keeps the fold and its reactivity simple —
 * but they are not part of the conversation, so they are not part of this.
 */
export function visibleItems(state: TranscriptState): TranscriptItem[] {
  return active(state).filter((item) => item.kind !== 'surface' || item.slot !== 'panel')
}

function active(state: TranscriptState): TranscriptItem[] {
  return state.items.filter((item) => state.activeSeqs.has(item.seq))
}

/** The tool calls the agent is blocked on. */
export function pendingApprovals(state: TranscriptState): ToolItem[] {
  return visibleItems(state).filter(
    (item): item is ToolItem => item.kind === 'tool' && item.status === 'pending'
  )
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
  // The request to branch is what moves the head, so it belongs to no branch itself.
  if (event.type === 'user.branch') {
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
    state.stopReason = null
  }
  if (event.type === 'session.status_idle') {
    state.status = 'idle'
    state.stopReason = event.stopReason
    closeOpenAgentItem(state)
  }
  if (event.type === 'session.status_terminated') {
    state.status = 'terminated'
    closeOpenAgentItem(state)
  }
}

function applyMessage(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'user.message') {
    state.items.push({
      kind: 'user',
      seq: event.seq,
      eventId: event.id,
      text: textOf(event.content),
      attachments: event.content.filter((block): block is ImageBlock => block.type === 'image')
    })
  }
  if (event.type === 'app.message') {
    state.items.push({
      kind: 'app',
      seq: event.seq,
      eventId: event.id,
      label: event.label,
      text: event.text
    })
  }
  if (event.type === 'user.unqueue') {
    dropModelVisibleMessage(state, event.messageId)
  }
  if (event.type === 'agent.message_start') {
    state.items.push({
      kind: 'agent',
      seq: event.seq,
      eventId: event.id,
      thinking: '',
      text: '',
      streaming: true
    })
  }
  if (event.type === 'agent.thinking_delta') {
    openAgentItem(state, event).thinking += event.text
  }
  if (event.type === 'agent.message_delta') {
    openAgentItem(state, event).text += event.text
  }
  if (event.type === 'agent.message_end') {
    finishAgentItem(state, event)
  }
}

function applyTool(state: TranscriptState, event: SessionEvent): void {
  if (event.type === 'agent.tool_use') {
    closeOpenAgentItem(state)
    state.items.push({
      kind: 'tool',
      seq: event.seq,
      eventId: event.id,
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input,
      editedInput: undefined,
      permission: event.permission,
      status: initialToolStatus(event.permission),
      progress: '',
      result: ''
    })
  }
  if (event.type === 'agent.tool_use_edited') {
    const tool = findTool(state, event.toolUseId)
    if (tool) {
      tool.editedInput = event.input
    }
  }
  if (event.type === 'agent.tool_progress') {
    const tool = findTool(state, event.toolUseId)
    if (tool) {
      tool.progress = event.message
    }
  }
  if (event.type === 'user.tool_confirmation') {
    applyConfirmation(state, event.toolUseId, event.result)
  }
  if (event.type === 'agent.tool_result') {
    applyToolResult(state, event.toolUseId, event.content, event.isError)
  }
}

function applyShell(state: TranscriptState, event: SessionEvent): void {
  if (event.type !== 'session.shell_result') {
    return
  }
  state.items.push({
    kind: 'shell',
    seq: event.seq,
    eventId: event.id,
    command: event.command,
    output: event.output,
    exitCode: event.exitCode,
    outcome: event.outcome,
    shared: event.share
  })
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
  }
  if (event.type === 'session.status_terminated') {
    pushNotice(state, event, 'info', `Session terminated: ${event.reason}`)
  }
  if (event.type === 'user.interrupt') {
    pushNotice(state, event, 'info', 'Interrupted.')
  }
  if (event.type === 'session.compacted') {
    pushNotice(state, event, 'info', `Compacted ${event.droppedMessages} messages.`)
  }
  if (event.type === 'session.forked') {
    pushNotice(state, event, 'info', `Forked into a new session at seq ${event.afterSeq}.`)
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

function initialToolStatus(permission: ToolPermission): ToolStatus {
  if (permission === 'ask') {
    return 'pending'
  }
  return 'running'
}

function applyConfirmation(state: TranscriptState, toolUseId: string, result: string): void {
  const tool = findTool(state, toolUseId)
  if (!tool) {
    return
  }
  if (result === 'deny') {
    tool.status = 'denied'
    return
  }
  tool.status = 'running'
}

function applyToolResult(
  state: TranscriptState,
  toolUseId: string,
  content: string,
  isError: boolean
): void {
  const tool = findTool(state, toolUseId)
  if (!tool) {
    return
  }
  tool.result = content
  tool.progress = ''
  tool.status = isError ? 'error' : 'ok'
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

function lastActiveItem(state: TranscriptState): TranscriptItem | undefined {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (item !== undefined && state.activeSeqs.has(item.seq)) {
      return item
    }
  }
  return undefined
}

/** The agent block currently being streamed into, created on demand for deltas without a start. */
function openAgentItem(state: TranscriptState, event: SessionEvent): AgentItem {
  const last = lastActiveItem(state)
  if (last && last.kind === 'agent' && last.streaming) {
    return last
  }

  const created: AgentItem = {
    kind: 'agent',
    seq: event.seq,
    eventId: event.id,
    thinking: '',
    text: '',
    streaming: true
  }
  state.items.push(created)
  return created
}

function closeOpenAgentItem(state: TranscriptState): void {
  const last = lastActiveItem(state)
  if (last && last.kind === 'agent') {
    last.streaming = false
  }
}

/** Deltas may be missing (non-streaming providers), so fall back to the assembled blocks. */
function finishAgentItem(
  state: TranscriptState,
  event: SessionEvent & { type: 'agent.message_end' }
): void {
  const item = openAgentItem(state, event)
  item.streaming = false

  if (item.text.length === 0) {
    item.text = joinText(event.content)
  }
  // An assistant turn that only called tools leaves an empty block behind; drop it.
  if (item.text.length === 0 && item.thinking.length === 0) {
    state.items.splice(state.items.indexOf(item), 1)
  }
}

function joinText(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
