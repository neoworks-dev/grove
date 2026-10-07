// Why an agent made an edit, as far as its session tells.
//
// Prompt blame keeps this beside the prompt so a line can be understood after
// the session is gone: the explanation the agent gave with the call (grove's
// edit and write tools ask for one), and what it said and thought in the turn
// leading up to the call. The reasoning keeps its end, which is nearest the
// edit, and is capped so a long turn does not bloat every record it writes.

import type { AgentEditStep, SessionEvent } from '../../shared/agents'
import { chunkText, toolCalls, updateOf } from './acpLog'

// Enough for the few paragraphs before an edit, small enough to store per step.
const REASONING_LIMIT = 4000

export interface EditRationale {
  /** What the call's `explanation` argument said; '' when it had none. */
  explanation: string
  /** The agent's words and thoughts between the turn's start and the call. */
  reasoning: string
}

/** The explanation and reasoning behind one edit step. */
export function rationaleOf(events: readonly SessionEvent[], step: AgentEditStep): EditRationale {
  return {
    explanation: explanationOf(events, step.toolCallId),
    reasoning: reasoningBefore(events, step.turnSeq, step.seq)
  }
}

/** The `explanation` a call was made with, or ''. */
function explanationOf(events: readonly SessionEvent[], toolCallId: string): string {
  const call = toolCalls(events).get(toolCallId)
  if (!call) {
    return ''
  }
  const input = call.input as { explanation?: unknown } | null
  if (!input || typeof input.explanation !== 'string') {
    return ''
  }
  return input.explanation.trim()
}

/**
 * The agent's text and thinking after `turnSeq` and before `callSeq`, one
 * paragraph per run of chunks, cut from the front to the limit.
 */
export function reasoningBefore(
  events: readonly SessionEvent[],
  turnSeq: number | null,
  callSeq: number
): string {
  const segments: string[] = []
  let current = ''
  for (const event of events) {
    if (turnSeq !== null && event.seq <= turnSeq) continue
    if (event.seq >= callSeq) break
    const update = updateOf(event)
    const isChunk =
      update !== null &&
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')
    if (isChunk) {
      current += chunkText(update)
      continue
    }
    // Anything else between chunks (a tool call, a result) ends the paragraph.
    current = pushSegment(segments, current)
  }
  pushSegment(segments, current)
  return keepEnd(segments.join('\n\n'), REASONING_LIMIT)
}

/** Adds a finished paragraph if it holds anything; returns the empty next one. */
function pushSegment(segments: string[], segment: string): string {
  const trimmed = segment.trim()
  if (trimmed.length > 0) {
    segments.push(trimmed)
  }
  return ''
}

/** The last `limit` characters of a text, marked as cut when they are not all of it. */
function keepEnd(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  return `…${text.slice(text.length - limit + 1)}`
}
