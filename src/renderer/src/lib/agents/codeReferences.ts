// Paths an agent names in passing — `src/auth.ts:42`, or bare in a sentence —
// read out of its message so they can open the code they point at.
//
// This only finds what looks like a path. Whether it is one is main's call: a
// candidate becomes a link once the file turns out to exist in the worktree, so
// `v1.2` or `Node.js` cost a lookup and nothing else.

export interface CodeReference {
  /** As the message named it; `worktreePathOf` makes it worktree-relative. */
  path: string
  line?: number
  endLine?: number
}

export interface ProseReference extends CodeReference {
  /** Where the reference starts in the text, and how long it runs. */
  index: number
  length: number
}

// A path: segments of name characters joined by slashes. No spaces, no quotes,
// no brackets — nothing a sentence around it would lend it.
const PATH = String.raw`(?:\.\/|\/)?[\w@+-][\w@+.-]*(?:\/[\w@+.-]+)*`

// What can follow the path to say where in it: `:42`, `:42-48`, `:42:7` (the
// column is dropped) or GitHub's `#L42-L48`.
const POSITION = String.raw`(?::(\d+)(?:[-–](\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)?`

// Inline code that is a path and nothing else.
const WHOLE = new RegExp(`^(${PATH})${POSITION}$`)

// In prose a path needs an extension, so ordinary words are left alone, and it
// can't start partway through a word, a path or a URL.
const IN_PROSE = new RegExp(
  String.raw`(?<![\w/.@+:-])(${PATH}\.[A-Za-z0-9]+)${POSITION}(?![\w/])`,
  'g'
)

/** The reference inline code makes when its whole text is a path, or null. */
export function parseCodeReference(text: string): CodeReference | null {
  const match = WHOLE.exec(text.trim())
  if (!match) {
    return null
  }
  return referenceOf(match)
}

/** Every path a stretch of prose names, in order. */
export function findCodeReferences(text: string): ProseReference[] {
  const found: ProseReference[] = []
  for (const match of text.matchAll(IN_PROSE)) {
    found.push({ ...referenceOf(match), index: match.index, length: match[0].length })
  }
  return found
}

/**
 * The reference's path relative to the worktree at `root`, or null when it
 * points outside it. Absolute paths are kept only when they are inside.
 */
export function worktreePathOf(path: string, root: string): string | null {
  let relative = path
  if (relative.startsWith('/')) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (!relative.startsWith(prefix)) {
      return null
    }
    relative = relative.slice(prefix.length)
  }
  if (relative.startsWith('./')) {
    relative = relative.slice(2)
  }
  if (relative.split('/').includes('..') || relative.length === 0) {
    return null
  }
  return relative
}

/** The reference a WHOLE or IN_PROSE match describes. */
function referenceOf(match: RegExpMatchArray): CodeReference {
  const reference: CodeReference = { path: match[1] }
  let start = match[2]
  let end = match[3]
  if (start === undefined) {
    start = match[4]
    end = match[5]
  }
  if (start === undefined) {
    return reference
  }
  reference.line = Number(start)
  reference.endLine = reference.line
  if (end !== undefined && Number(end) >= reference.line) {
    reference.endLine = Number(end)
  }
  return reference
}
