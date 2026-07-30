// Vendored from nib (web/src/renderer/lib/completion.ts), reformatted to grove's style.
// Unchanged otherwise — re-vendor by copying the file over and running prettier.
/**
 * What the caret is currently sitting on, so the composer knows whether to offer commands or files.
 *
 * Deliberately positional rather than stateful: a completion popup driven by "did the user just
 * type `@`" gets out of step the moment they click elsewhere, undo, or paste. Deriving it from the
 * text and the caret means it is always right.
 */

export type CompletionKind = 'command' | 'file'

export interface Completion {
  kind: CompletionKind
  /** What to search for — the token without its sigil. */
  query: string
  /** The span to replace when a suggestion is accepted, sigil included. */
  start: number
  end: number
}

export function activeCompletion(text: string, caret: number): Completion | null {
  return commandAt(text, caret) ?? fileAt(text, caret)
}

/** Only the first word of the message, and only when it opens with a single slash. */
function commandAt(text: string, caret: number): Completion | null {
  if (!text.startsWith('/') || text.startsWith('//')) {
    return null
  }

  const end = firstBreakAfter(text, 1)
  if (caret < 1 || caret > end) {
    return null
  }
  return { kind: 'command', query: text.slice(1, end), start: 0, end }
}

/** An `@` that opens a word, with no whitespace between it and the caret. */
function fileAt(text: string, caret: number): Completion | null {
  const start = text.lastIndexOf('@', Math.max(0, caret - 1))
  if (start === -1) {
    return null
  }

  const before = text[start - 1]
  if (before !== undefined && !/\s/.test(before)) {
    return null
  }

  const query = text.slice(start + 1, caret)
  if (/\s/.test(query)) {
    return null
  }
  return { kind: 'file', query, start, end: caret }
}

function firstBreakAfter(text: string, from: number): number {
  const match = /\s/.exec(text.slice(from))
  return match === null ? text.length : from + match.index
}

export function applyCompletion(text: string, completion: Completion, value: string): string {
  const replacement = completion.kind === 'command' ? `/${value} ` : `@${value} `
  return text.slice(0, completion.start) + replacement + text.slice(completion.end)
}

export type Submission =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'shell'; command: string; share: boolean }

/**
 * What a submitted draft means.
 *
 * `!` runs a command and shows the model the output, `!!` keeps it to yourself, `/` runs a slash
 * command, and everything else is a message. `//` is the escape hatch for a message that genuinely
 * starts with a slash.
 */
export function parseSubmission(draft: string): Submission | null {
  const text = draft.trim()
  if (text.length === 0) {
    return null
  }

  if (text.startsWith('!!')) {
    return shell(text.slice(2), false)
  }
  if (text.startsWith('!')) {
    return shell(text.slice(1), true)
  }
  if (text.startsWith('//')) {
    return { kind: 'message', text: text.slice(1) }
  }
  if (text.startsWith('/')) {
    const end = firstBreakAfter(text, 1)
    return { kind: 'command', name: text.slice(1, end), args: text.slice(end).trim() }
  }
  return { kind: 'message', text }
}

function shell(command: string, share: boolean): Submission | null {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return null
  }
  return { kind: 'shell', command: trimmed, share }
}
