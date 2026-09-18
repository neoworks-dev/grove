// What the composer's formatting buttons do to the text.
//
// Every one of them is "wrap the selection" or "prefix each selected line", and
// both have the same awkward cases: nothing selected, a selection that already
// carries the formatting, several lines at once. Keeping it here means those
// cases are decided once and can be tested without a textarea.

export type MarkdownEdit =
  'bold' | 'italic' | 'code' | 'heading' | 'quote' | 'link' | 'bullets' | 'numbers' | 'tasks'

export interface EditResult {
  text: string
  /** Where the caret goes, or the range to leave selected. */
  selectionStart: number
  selectionEnd: number
}

interface Wrap {
  before: string
  after: string
  /** Shown selected when the button is pressed with no selection. */
  placeholder: string
}

const WRAPS: Partial<Record<MarkdownEdit, Wrap>> = {
  bold: { before: '**', after: '**', placeholder: 'bold text' },
  italic: { before: '_', after: '_', placeholder: 'italic text' },
  code: { before: '`', after: '`', placeholder: 'code' },
  link: { before: '[', after: '](url)', placeholder: 'title' }
}

const PREFIXES: Partial<Record<MarkdownEdit, (index: number) => string>> = {
  heading: () => '### ',
  quote: () => '> ',
  bullets: () => '- ',
  tasks: () => '- [ ] ',
  numbers: (index) => `${index + 1}. `
}

/** The line the offset sits on, as a [start, end) range over the text. */
function lineRangeAt(text: string, offset: number): [number, number] {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const lineEnd = text.indexOf('\n', offset)
  return [start, lineEnd === -1 ? text.length : lineEnd]
}

/** Apply a wrapping edit, unwrapping instead when it is already applied. */
function applyWrap(text: string, start: number, end: number, wrap: Wrap): EditResult {
  const selected = text.slice(start, end)

  // Already wrapped: take it off, so the button toggles.
  const before = text.slice(Math.max(0, start - wrap.before.length), start)
  const after = text.slice(end, end + wrap.after.length)
  if (selected.length > 0 && before === wrap.before && after === wrap.after) {
    const from = start - wrap.before.length
    return {
      text: text.slice(0, from) + selected + text.slice(end + wrap.after.length),
      selectionStart: from,
      selectionEnd: from + selected.length
    }
  }

  const body = selected.length > 0 ? selected : wrap.placeholder
  const inserted = wrap.before + body + wrap.after
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selectionStart: start + wrap.before.length,
    selectionEnd: start + wrap.before.length + body.length
  }
}

/** Apply a per-line prefix, removing it instead when every line has it. */
function applyPrefix(
  text: string,
  start: number,
  end: number,
  prefixFor: (index: number) => string
): EditResult {
  const [blockStart] = lineRangeAt(text, start)
  const [, blockEnd] = lineRangeAt(text, end)
  const lines = text.slice(blockStart, blockEnd).split('\n')

  const allPrefixed = lines.every((line, index) => line.startsWith(prefixFor(index)))
  const next = lines
    .map((line, index) => {
      const prefix = prefixFor(index)
      if (allPrefixed) return line.slice(prefix.length)
      return prefix + line
    })
    .join('\n')

  return {
    text: text.slice(0, blockStart) + next + text.slice(blockEnd),
    selectionStart: blockStart,
    selectionEnd: blockStart + next.length
  }
}

/** The text and selection after pressing one of the formatting buttons. */
export function applyMarkdownEdit(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  edit: MarkdownEdit
): EditResult {
  const wrap = WRAPS[edit]
  if (wrap) return applyWrap(text, selectionStart, selectionEnd, wrap)
  const prefix = PREFIXES[edit]
  if (prefix) return applyPrefix(text, selectionStart, selectionEnd, prefix)
  return { text, selectionStart, selectionEnd }
}
