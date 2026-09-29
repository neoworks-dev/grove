// Reading a session log's harness events, which are ACP as switchboard reported it.
//
// ACP reports a turn in pieces: a message arrives as chunks, a tool call as a
// first report and then updates that refine and settle it. Everything in main
// that reads a log — the transcript tools, the listing preview, the hand-off to
// a parent agent, the review bridge — wants the whole of each instead, so the
// folding lives here once.

import type { SessionUpdate, ToolCallUpdate } from '@neoworks/harness'
import type { SessionEvent } from '../../shared/agents'

type ToolCallContent = NonNullable<ToolCallUpdate['content']>[number]

/** One update of a given kind, with the event that carried it. */
export type UpdateOf<Kind extends SessionUpdate['sessionUpdate']> = Extract<
  SessionUpdate,
  { sessionUpdate: Kind }
>

/** A whole message from the agent, gathered from its chunks. */
export interface AgentMessage {
  /** The event that carried its first chunk. */
  seq: number
  at: string
  text: string
}

/** A tool call as its updates left it. */
export interface ToolCallState {
  toolCallId: string
  /** The event that first reported it. */
  seq: number
  at: string
  name: string
  title: string
  kind: string
  status: string
  input: unknown
  content: ToolCallContent[]
  rawOutput: unknown
  /** The event that settled it, once one has. */
  settledSeq: number | null
}

/** The session update an event carries, or null when it carries none. */
export function updateOf(event: SessionEvent): SessionUpdate | null {
  if (event.type !== 'update') return null
  return event.update
}

/**
 * The agent's messages, in order. A message runs from its first chunk until
 * something else happens in the conversation — a tool call, a user message, the
 * turn ending — or the harness starts a message with another id.
 */
export function agentMessages(events: readonly SessionEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = []
  let open: (AgentMessage & { messageId: string | null }) | null = null
  for (const event of events) {
    const update = updateOf(event)
    if (!update) {
      if (breaksMessage(event)) open = null
      continue
    }
    if (update.sessionUpdate === 'agent_thought_chunk') continue
    if (update.sessionUpdate !== 'agent_message_chunk') {
      if (update.sessionUpdate === 'tool_call') open = null
      continue
    }
    const messageId = update.messageId ?? null
    const another = open !== null && messageId !== null && open.messageId !== messageId
    if (open === null || another) {
      open = { seq: event.seq, at: event.createdAt, text: '', messageId }
      messages.push(open)
    }
    open.text += chunkText(update)
  }
  return messages.map(({ seq, at, text }) => ({ seq, at, text }))
}

/**
 * The agent's last message, read from the end of the log so a listing does not
 * fold every session whole. Null when the agent has said nothing since the last
 * user message.
 */
export function lastAgentMessage(events: readonly SessionEvent[]): AgentMessage | null {
  const chunks: string[] = []
  let first: SessionEvent | null = null
  let messageId: string | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const update = updateOf(event)
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const id = update.messageId ?? null
      if (first !== null && messageId !== null && id !== null && id !== messageId) break
      if (id !== null) messageId = id
      chunks.push(chunkText(update))
      first = event
      continue
    }
    if (update?.sessionUpdate === 'agent_thought_chunk') continue
    // Before the message is found, anything but a user turn may sit after it.
    if (first === null && event.type !== 'user.message' && event.type !== 'app.message') continue
    break
  }
  if (first === null) return null
  return { seq: first.seq, at: first.createdAt, text: chunks.reverse().join('') }
}

/** Every tool call on the log by id, each as its latest update left it. */
export function toolCalls(events: readonly SessionEvent[]): Map<string, ToolCallState> {
  const calls = new Map<string, ToolCallState>()
  for (const event of events) {
    const update = updateOf(event)
    if (!update) continue
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      continue
    }
    applyToolUpdate(calls, update, event)
  }
  return calls
}

/** Fold one tool call update into the calls known so far. */
export function applyToolUpdate(
  calls: Map<string, ToolCallState>,
  update: ToolCallUpdate,
  event: { seq: number; createdAt: string }
): ToolCallState {
  let call = calls.get(update.toolCallId)
  if (!call) {
    call = {
      toolCallId: update.toolCallId,
      seq: event.seq,
      at: event.createdAt,
      name: '',
      title: '',
      kind: 'other',
      status: 'pending',
      input: {},
      content: [],
      rawOutput: undefined,
      settledSeq: null
    }
    calls.set(update.toolCallId, call)
  }
  const name = toolNameOf(update)
  if (name) call.name = name
  if (update.title) call.title = update.title
  if (update.kind) call.kind = update.kind
  if (update.rawInput !== undefined) call.input = update.rawInput
  if (update.content) call.content = update.content
  if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput
  if (update.status) call.status = update.status
  if (isSettled(call.status) && call.settledSeq === null) call.settledSeq = event.seq
  return call
}

/** Whether a call has finished, one way or the other. */
export function isSettled(status: string): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * The tool's own name: ACP's `name`, or the one Claude's adapter keeps in its
 * metadata. A harness that reports neither is named by its title.
 */
export function toolNameOf(update: {
  name?: string | null
  title?: string | null
  _meta?: unknown
}): string | null {
  if (update.name) return update.name
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | null | undefined
  const toolName = meta?.claudeCode?.toolName
  if (typeof toolName === 'string') return toolName
  return null
}

/** The text of a call's result: its text content, else whatever it reported raw. */
export function resultText(call: ToolCallState): string {
  const text = call.content
    .map(contentText)
    .filter((part) => part.length > 0)
    .join('\n')
  if (text.length > 0) return text
  if (typeof call.rawOutput === 'string') return call.rawOutput
  return ''
}

/** The file changes a call carries, as ACP diffs. */
export function diffsOf(
  content: readonly ToolCallContent[] | null | undefined
): { path: string; oldText: string | null; newText: string }[] {
  if (!content) return []
  const diffs: { path: string; oldText: string | null; newText: string }[] = []
  for (const entry of content) {
    if (entry.type !== 'diff') continue
    const diff = entry as { path: string; oldText?: string | null; newText: string }
    let oldText: string | null = null
    if (typeof diff.oldText === 'string') oldText = diff.oldText
    diffs.push({ path: diff.path, oldText, newText: diff.newText })
  }
  return diffs
}

/** The text of one message chunk. */
export function chunkText(update: UpdateOf<'agent_message_chunk'> | UpdateOf<'agent_thought_chunk'>): string {
  if (update.content.type !== 'text') return ''
  return update.content.text
}

function contentText(entry: ToolCallContent): string {
  if (entry.type !== 'content') return ''
  const block = (entry as { content: { type: string; text?: string } }).content
  if (block.type !== 'text' || typeof block.text !== 'string') return ''
  return block.text
}

/** Whether a grove event ends whatever the agent was saying. */
function breaksMessage(event: SessionEvent): boolean {
  return (
    event.type === 'user.message' ||
    event.type === 'app.message' ||
    event.type === 'session.status_idle' ||
    event.type === 'session.status_running' ||
    event.type === 'permission'
  )
}
