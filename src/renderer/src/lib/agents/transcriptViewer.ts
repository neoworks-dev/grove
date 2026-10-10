/**
 * The detailed transcript: every item flattened into plain text lines, the way a
 * terminal pager would show it, with tool details open and a time on each message.
 * Lines are the unit the viewer scrolls, jumps and searches by.
 */

import type { ToolItem, TranscriptItem } from './transcript'

export type ViewerLineKind = 'header' | 'body' | 'detail'

export interface ViewerLine {
  text: string
  kind: ViewerLineKind
  /** The line opens a prompt, which `{` and `}` jump between. */
  promptStart: boolean
}

export interface ViewerSource {
  items: TranscriptItem[]
  /** When each event happened, by seq. */
  createdAt: Map<number, string>
  /** The model the session runs on; the log records no model per message. */
  model: string
}

/** The longest a tool result is shown for, in lines; the rest is counted. */
const MAX_RESULT_LINES = 400

/** The time of day an event happened, or an empty string when the log has no time for it. */
export function clockOf(isoTime: string | undefined): string {
  if (isoTime === undefined) return ''
  const date = new Date(isoTime)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** A header line: who spoke, then the time it happened when the log has one. */
function headerLine(label: string, clock: string, promptStart: boolean): ViewerLine {
  let text = label
  if (clock !== '') text = `${label} · ${clock}`
  return { text, kind: 'header', promptStart }
}

/** A text split into body lines, with a blank one when it is empty so the message still shows. */
function bodyLines(text: string, kind: ViewerLineKind): ViewerLine[] {
  return text.split('\n').map((line) => ({ text: line, kind, promptStart: false }))
}

/** What a tool call ran with, as indented JSON, or a string as it is. */
function inputText(call: ToolItem): string {
  let input = call.input
  if (call.editedInput !== undefined && call.editedInput !== null) input = call.editedInput
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  return JSON.stringify(input, null, 2)
}

/** The result of a call as the tool returned it, cut to MAX_RESULT_LINES. */
function resultLines(call: ToolItem): ViewerLine[] {
  let text = call.rawResult
  if (text === '') text = call.result
  if (text === '') return []
  const lines = bodyLines(text, 'detail')
  if (lines.length <= MAX_RESULT_LINES) return lines
  const hidden = lines.length - MAX_RESULT_LINES
  const shown = lines.slice(0, MAX_RESULT_LINES)
  shown.push({ text: `… ${hidden} more lines`, kind: 'detail', promptStart: false })
  return shown
}

/** A tool call: its name and status, what it ran with, and what it returned. */
function toolLines(call: ToolItem, clock: string): ViewerLine[] {
  const lines = [headerLine(`tool ${call.name} · ${call.status}`, clock, false)]
  if (call.title !== '') lines.push(...bodyLines(call.title, 'body'))
  const input = inputText(call)
  if (input !== '') {
    lines.push({ text: 'input', kind: 'detail', promptStart: false })
    lines.push(...bodyLines(input, 'detail'))
  }
  const result = resultLines(call)
  if (result.length > 0) {
    lines.push({ text: 'result', kind: 'detail', promptStart: false })
    lines.push(...result)
  }
  return lines
}

/** The lines of one item. */
function itemLines(item: TranscriptItem, source: ViewerSource): ViewerLine[] {
  const clock = clockOf(source.createdAt.get(item.seq))
  if (item.kind === 'user') {
    return [headerLine('you', clock, true), ...bodyLines(item.text, 'body')]
  }
  if (item.kind === 'agent') {
    const lines = [headerLine(`agent · ${source.model}`, clock, false)]
    if (item.thinking !== '') {
      lines.push({ text: 'thinking', kind: 'detail', promptStart: false })
      lines.push(...bodyLines(item.thinking, 'detail'))
    }
    lines.push(...bodyLines(item.text, 'body'))
    return lines
  }
  if (item.kind === 'tool') return toolLines(item, clock)
  if (item.kind === 'shell') {
    const lines = [headerLine(`shell · exit ${item.exitCode}`, clock, false)]
    lines.push(...bodyLines(`$ ${item.command}`, 'body'))
    if (item.output !== '') lines.push(...bodyLines(item.output, 'detail'))
    return lines
  }
  if (item.kind === 'app') {
    return [headerLine(item.label, clock, false), ...bodyLines(item.text, 'body')]
  }
  if (item.kind === 'notice') {
    return [headerLine(item.tone, clock, false), ...bodyLines(item.text, 'body')]
  }
  if (item.kind === 'compaction') {
    return [
      headerLine(`compaction · ${item.status}`, clock, false),
      ...bodyLines(item.summary, 'body')
    ]
  }
  return [headerLine('panel', clock, false)]
}

/** The whole transcript as lines, a blank line between items. */
export function viewerLinesOf(source: ViewerSource): ViewerLine[] {
  const lines: ViewerLine[] = []
  for (const item of source.items) {
    if (lines.length > 0) lines.push({ text: '', kind: 'body', promptStart: false })
    lines.push(...itemLines(item, source))
  }
  return lines
}

/**
 * The prompt line to jump to from `fromLine`: the next one after it going forward, the
 * previous one before it going back. Null when there is none in that direction.
 */
export function promptLineFrom(
  lines: ViewerLine[],
  fromLine: number,
  direction: 1 | -1
): number | null {
  let index = fromLine + direction
  while (index >= 0 && index < lines.length) {
    if (lines[index].promptStart) return index
    index += direction
  }
  return null
}

/** The indexes of the lines that contain `query`, ignoring case; none for an empty query. */
export function matchingLines(lines: ViewerLine[], query: string): number[] {
  if (query === '') return []
  const needle = query.toLowerCase()
  const found: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].text.toLowerCase().includes(needle)) found.push(index)
  }
  return found
}

/**
 * The match after (or before) `current`, wrapping around the ends. `current` is a line
 * index that need not be a match itself; null when there are no matches.
 */
export function stepMatch(matches: number[], current: number, direction: 1 | -1): number | null {
  if (matches.length === 0) return null
  if (direction === 1) {
    const later = matches.find((line) => line > current)
    if (later !== undefined) return later
    return matches[0]
  }
  const earlier = matches.filter((line) => line < current)
  if (earlier.length > 0) return earlier[earlier.length - 1]
  return matches[matches.length - 1]
}

export interface LineSegment {
  text: string
  match: boolean
}

/** A line split at every occurrence of `query`, so the occurrences can be marked. */
export function highlightSegments(text: string, query: string): LineSegment[] {
  if (query === '') return [{ text, match: false }]
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const segments: LineSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const at = haystack.indexOf(needle, cursor)
    if (at === -1) break
    if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false })
    segments.push({ text: text.slice(at, at + needle.length), match: true })
    cursor = at + needle.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  if (segments.length === 0) return [{ text, match: false }]
  return segments
}
