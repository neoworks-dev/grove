// What a session looks like in a listing: a name taken from what it was first
// asked, and the last thing said in it. Both are read off the event log the
// store already keeps in memory, so listing every session costs no extra I/O.

import type { SessionEvent, SessionPreview } from '../../shared/agents'

/** Longest title taken from a prompt before it is cut at a word boundary. */
const TITLE_MAX_CHARS = 48

/** Longest preview kept; the row truncates further to fit. */
const PREVIEW_MAX_CHARS = 240

// The names grove gives a session nobody has named: `Session`, `Session 3`.
const DEFAULT_TITLE = /^Session( \d+)?$/

/** Whether a title is one grove made up rather than one a person or agent chose. */
export function isDefaultTitle(title: string): boolean {
  return title.trim().length === 0 || DEFAULT_TITLE.test(title.trim())
}

/**
 * A short name for a session from its first prompt: the first line that says
 * anything, without markdown markers, cut at a word boundary. Null when the
 * prompt has no text to name it by.
 */
export function titleFromPrompt(prompt: string): string | null {
  const line = prompt
    .split('\n')
    .map((candidate) => stripMarkdown(candidate))
    .find((candidate) => candidate.length > 0)
  if (!line) {
    return null
  }
  return truncateAtWord(line, TITLE_MAX_CHARS)
}

/** The last message in the log that has text, from either side. */
export function lastMessagePreview(events: readonly SessionEvent[]): SessionPreview | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const preview = previewOf(events[index])
    if (preview) {
      return preview
    }
  }
  return null
}

/** The text of the first prompt in the log, or null before there is one. */
export function firstPromptText(events: readonly SessionEvent[]): string | null {
  for (const event of events) {
    if (event.type !== 'user.message') {
      continue
    }
    const text = joinedText(event.content)
    if (text.length > 0) {
      return text
    }
  }
  return null
}

/** A preview for one event, when it is a message with text. */
function previewOf(event: SessionEvent): SessionPreview | null {
  if (event.type === 'user.message') {
    return previewFrom('user', joinedText(event.content))
  }
  if (event.type === 'agent.message_end') {
    return previewFrom('agent', joinedText(event.content))
  }
  return null
}

/** A preview of `text` on one line without markdown markers, or null when there is nothing to show. */
function previewFrom(from: SessionPreview['from'], text: string): SessionPreview | null {
  const oneLine = text
    .split('\n')
    .map((line) => stripMarkdown(line))
    .filter((line) => line.length > 0)
    .join(' ')
  if (oneLine.length === 0) {
    return null
  }
  return { from, text: oneLine.slice(0, PREVIEW_MAX_CHARS) }
}

/** The text blocks of a message, joined. */
function joinedText(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** One line without heading, quote, list and emphasis markers, whitespace collapsed. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `text` cut to `max` characters at the last word boundary, with an ellipsis. */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace < max / 2) {
    return `${cut.trimEnd()}…`
  }
  return `${cut.slice(0, lastSpace).trimEnd()}…`
}
