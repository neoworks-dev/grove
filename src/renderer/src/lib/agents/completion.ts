/**
 * What the caret is currently sitting on, so the composer knows whether to offer commands or files.
 *
 * Deliberately positional rather than stateful: a completion popup driven by "did the user just
 * type `@`" gets out of step the moment they click elsewhere, undo, or paste. Deriving it from the
 * text and the caret means it is always right.
 */

// `shell` completes a word of a `!` draft, answered by the user's own shell.
export type CompletionKind = 'command' | 'file' | 'shell'

export interface Completion {
  kind: CompletionKind
  /** What to search for — the token without its sigil. */
  query: string
  /** The span to replace when a suggestion is accepted, sigil included. */
  start: number
  end: number
  /** For `shell`: the command as typed up to the caret, which the shell completes. */
  line?: string
}

/**
 * `requested` is a Tab press: in a shell draft it asks for completions even
 * with nothing of the word typed yet, the way a shell's Tab lists subcommands.
 */
export function activeCompletion(text: string, caret: number, requested = false): Completion | null {
  const shell = shellDraft(text)
  if (shell) {
    return shellWordAt(text, caret, shell, requested)
  }
  return commandAt(text, caret) ?? fileAt(text, caret)
}

/**
 * The word of a `!` command the caret ends, once something of it is typed or a
 * Tab asked for it.
 */
function shellWordAt(
  text: string,
  caret: number,
  shell: ShellDraft,
  requested: boolean
): Completion | null {
  const commandStart = shell.lead.length + shell.marker.length
  if (caret < commandStart) {
    return null
  }

  const line = text.slice(commandStart, caret)
  const wordStart = commandStart + line.search(/\S*$/)
  const query = text.slice(wordStart, caret)
  if (query.length === 0 && !requested) {
    return null
  }
  return { kind: 'shell', query, start: wordStart, end: caret, line }
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

export interface DraftSegment {
  text: string
  /** An `@file` reference, which the composer paints so it reads as one token. */
  mention: boolean
}

// The same rule `fileAt` completes on: an `@` that opens a word, running to the
// next space.
const MENTION = /(^|\s)(@\S+)/g

/**
 * A draft split into plain runs and the mentions between them, for the layer drawn behind the
 * textarea. Concatenating the segments gives the draft back, which is what keeps the layer in
 * register with the text it sits under.
 */
export function draftSegments(text: string): DraftSegment[] {
  const segments: DraftSegment[] = []
  let index = 0

  for (const match of text.matchAll(MENTION)) {
    const start = match.index + match[1].length
    if (start > index) {
      segments.push({ text: text.slice(index, start), mention: false })
    }
    segments.push({ text: match[2], mention: true })
    index = start + match[2].length
  }

  if (index < text.length) {
    segments.push({ text: text.slice(index), mention: false })
  }
  return segments
}

/** A draft bound for grove's shell: the `!` marker, and the command after it. */
export interface ShellDraft {
  /** Whatever precedes the marker — whitespace only, kept so the layer lines up. */
  lead: string
  marker: '!' | '!!'
  command: string
}

// `!!` first, so a private command is not read as a shared one starting with `!`.
const SHELL_DRAFT = /^(\s*)(!!|!)([\s\S]*)$/

/**
 * Split a `!` draft into the parts the highlight layer paints separately: the marker as a marker,
 * the rest as the shell command it is.
 *
 * Null for anything that is not a shell draft. The three parts always concatenate back to the
 * draft, which is what keeps the painted copy in register with the textarea under it.
 */
export function shellDraft(draft: string): ShellDraft | null {
  const match = SHELL_DRAFT.exec(draft)
  if (!match) {
    return null
  }
  return { lead: match[1], marker: match[2] as '!' | '!!', command: match[3] }
}

function firstBreakAfter(text: string, from: number): number {
  const match = /\s/.exec(text.slice(from))
  return match === null ? text.length : from + match.index
}

/** The draft with the completed span replaced by the accepted suggestion. */
export function applyCompletion(text: string, completion: Completion, value: string): string {
  const replacement = completionText(completion.kind, value)
  return text.slice(0, completion.start) + replacement + text.slice(completion.end)
}

/**
 * What an accepted suggestion is written as. Shell words go in bare, and a
 * directory gets no trailing space so completion can carry on into it.
 */
function completionText(kind: CompletionKind, value: string): string {
  if (kind === 'command') {
    return `/${value} `
  }
  if (kind === 'file') {
    return `@${value} `
  }
  if (value.endsWith('/')) {
    return value
  }
  return `${value} `
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
