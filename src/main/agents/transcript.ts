// Reading a session's log the way a person would read it.
//
// The event log is the whole truth of a session, but it is a stream of deltas,
// tool bookkeeping and UI surfaces — no use to an agent asked what another
// agent found out. This folds it into speaker-tagged lines, which is what the
// transcript tools hand back and what a search matches against.
//
// The fold is deliberately lossy: message deltas are dropped in favour of the
// finished message, and tool traffic is left out unless it is asked for, since
// most questions about another session are about what was said, not what was
// called.

import type { ContentBlock, SessionEvent, UserContentBlock } from '../../shared/agents'

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
  const lines: TranscriptLine[] = []
  for (const event of events) {
    const line = lineOf(event)
    if (!line) continue
    if (line.speaker === 'tool' && !options.includeTools) continue
    if (line.text.trim() === '') continue
    lines.push(line)
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
    case 'agent.message_end':
      return { ...at, speaker: 'agent', text: blockText(event.content) }
    case 'agent.tool_use':
      return { ...at, speaker: 'tool', label: event.name, text: clip(inputText(event.input)) }
    case 'agent.tool_result':
      return { ...at, speaker: 'tool', label: event.name, text: resultText(event) }
    case 'session.shell_result':
      return {
        ...at,
        speaker: 'tool',
        label: 'shell',
        text: clip(`${event.command}\n${event.output}`)
      }
    case 'session.command_output':
      return { ...at, speaker: 'system', text: event.text }
    case 'session.compacted':
      return { ...at, speaker: 'system', label: 'compacted', text: event.summary }
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

function blockText(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function resultText(event: { content: string; isError: boolean }): string {
  if (event.isError) return clip(`error: ${event.content}`)
  return clip(event.content)
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
