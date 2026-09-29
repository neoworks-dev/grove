// Reading a session's log the way a person would read it.
//
// The event log is the whole truth of a session, but it is a stream of deltas,
// tool bookkeeping and UI surfaces — no use to an agent asked what another
// agent found out. This folds it into speaker-tagged lines, which is what the
// transcript tools hand back and what a search matches against.
//
// The fold is deliberately lossy: message chunks are joined into the finished
// message, and tool traffic is left out unless it is asked for, since most
// questions about another session are about what was said, not what was called.

import type { SessionEvent, UserContentBlock } from '../../shared/agents'
import { agentMessages, resultText, toolCalls } from './acpLog'

export type Speaker = 'user' | 'agent' | 'tool' | 'system'

export interface TranscriptLine {
  seq: number
  /** When the event was recorded, ISO-8601, as the log stamped it. */
  at: string
  speaker: Speaker
  /** A tool's name, or who an app message came from. */
  label?: string
  text: string
}

export interface FoldOptions {
  /** Include tool calls, their results and shell output. Off by default. */
  includeTools?: boolean
}

/** How much of one tool call or result a line keeps. */
const TOOL_TEXT_LIMIT = 400

/** How much of a line a search result shows, on one line. */
const SNIPPET_LIMIT = 200

/** Fold an event log into the lines that carry what was said. */
export function transcriptLines(
  events: SessionEvent[],
  options: FoldOptions = {}
): TranscriptLine[] {
  const lines = [...groveLines(events), ...messageLines(events)]
  if (options.includeTools) lines.push(...toolLines(events))
  return lines
    .filter((line) => line.text.trim() !== '')
    .sort((left, right) => left.seq - right.seq)
}

/** What the user, other agents and grove itself put on the log. */
function groveLines(events: SessionEvent[]): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const event of events) {
    const line = lineOf(event)
    if (line) lines.push(line)
  }
  return lines
}

/** The agent's messages, each whole, at the event that began it. */
function messageLines(events: SessionEvent[]): TranscriptLine[] {
  return agentMessages(events).map((message) => ({
    seq: message.seq,
    at: message.at,
    speaker: 'agent',
    text: message.text
  }))
}

/** Each tool call where it was made, and its result where it settled. */
function toolLines(events: SessionEvent[]): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const call of toolCalls(events).values()) {
    const label = call.name || call.title
    lines.push({
      seq: call.seq,
      at: call.at,
      speaker: 'tool',
      label,
      text: clip(inputText(call.input))
    })
    if (call.settledSeq === null) continue
    lines.push({
      seq: call.settledSeq,
      at: call.at,
      speaker: 'tool',
      label,
      text: resultLine(resultText(call), call.status === 'failed')
    })
  }
  return lines
}

function lineOf(event: SessionEvent): TranscriptLine | null {
  const at = { seq: event.seq, at: event.createdAt }

  switch (event.type) {
    case 'user.message':
      return { ...at, speaker: 'user', text: userText(event.content) }
    case 'app.message':
      return { ...at, speaker: 'user', label: event.from ?? event.label, text: event.text }
    case 'session.shell_result':
      return {
        ...at,
        speaker: 'tool',
        label: 'shell',
        text: clip(`${event.command}\n${event.output}`)
      }
    case 'session.error':
      return { ...at, speaker: 'system', label: 'error', text: event.message }
    case 'session.notice':
      return { ...at, speaker: 'system', text: event.message }
    default:
      return null
  }
}

/** A user turn as text: attachments are named, not pasted twice. */
function userText(content: UserContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[image]'
      return `[${block.path}:${block.startLine}-${block.endLine}]`
    })
    .join('\n')
}

function resultLine(text: string, failed: boolean): string {
  if (failed) return clip(`error: ${text}`)
  return clip(text)
}

/** A tool's input as one readable string, whatever shape it came in. */
function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === null || input === undefined) return ''
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function clip(text: string): string {
  if (text.length <= TOOL_TEXT_LIMIT) return text
  return `${text.slice(0, TOOL_TEXT_LIMIT)}… (${text.length} chars)`
}

/**
 * Lines whose text or label contains the query, newest last.
 *
 * Matching is a case-insensitive substring rather than a pattern: an agent
 * writing the query has no way to test a regex first, and a broken one would
 * come back as "no matches" rather than as an error.
 */
export function searchLines(lines: TranscriptLine[], query: string, limit = 20): TranscriptLine[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits = lines.filter((line) => {
    if (line.text.toLowerCase().includes(needle)) return true
    return (line.label ?? '').toLowerCase().includes(needle)
  })
  if (hits.length <= limit) return hits
  return hits.slice(hits.length - limit)
}

/** One line as the tools print it: `#12 agent: …`. */
export function renderLine(line: TranscriptLine): string {
  const who = line.label ? `${line.speaker} (${line.label})` : line.speaker
  return `#${line.seq} ${who}: ${line.text}`
}

/** One line as a search hit: the same, flattened onto a single line. */
export function renderHit(line: TranscriptLine): string {
  const flat = line.text.replace(/\s+/g, ' ').trim()
  const text = flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat
  return renderLine({ ...line, text })
}
