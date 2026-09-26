// Issues and pull requests a piece of text refers to.
//
// Two shapes count: `#212`, and a link to an issue or pull request. Code does
// not — `#123` inside a fence or backticks is a colour, an anchor or a line of
// a diff far more often than an issue. Nor does a number that is plainly a
// position in a list ("step #2", "option #1"), which would otherwise pull up
// whatever unrelated issue happens to have that number.

// Words after which `#n` is a place in a list rather than an issue.
const ORDINAL_WORDS = new Set([
  'step',
  'steps',
  'option',
  'options',
  'item',
  'items',
  'point',
  'points',
  'line',
  'lines',
  'rule',
  'number',
  'no',
  'row',
  'column',
  'col',
  'phase',
  'part',
  'round',
  'attempt',
  'try',
  'case',
  'test',
  'version',
  'rank',
  'place'
])

const BARE_REFERENCE = /(^|[\s([{,;:])#(\d{1,7})(?![\w-])/g
const LINK_REFERENCE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g

/**
 * The references in `text`, in order and without repeats. A bare `#212` comes
 * back as `212`; a link comes back as `owner/repo#212`, since it may point at
 * another repository.
 */
export function githubReferences(text: string): string[] {
  const prose = withoutCode(text)
  const found: { at: number; key: string }[] = []

  for (const match of prose.matchAll(LINK_REFERENCE)) {
    found.push({ at: match.index, key: `${match[1]}#${match[2]}` })
  }
  for (const match of prose.matchAll(BARE_REFERENCE)) {
    const at = match.index + match[1].length
    if (isOrdinal(prose, at)) continue
    found.push({ at, key: match[2] })
  }

  found.sort((first, second) => first.at - second.at)
  const keys: string[] = []
  for (const entry of found) {
    if (!keys.includes(entry.key)) keys.push(entry.key)
  }
  return keys
}

/**
 * Split a reference key back up. The repository is null for a bare `#212`,
 * which always means the repository grove has open.
 */
export function parseReference(key: string): { repo: string | null; number: number } {
  const hash = key.lastIndexOf('#')
  if (hash === -1) return { repo: null, number: Number(key) }
  return { repo: key.slice(0, hash), number: Number(key.slice(hash + 1)) }
}

/** The text with fenced blocks and inline code blanked out, so offsets still line up. */
function withoutCode(text: string): string {
  const blank = (code: string): string => code.replace(/[^\n]/g, ' ')
  return text.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank)
}

/** Whether the word before position `at` makes the `#n` there a place in a list. */
function isOrdinal(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 20), at)
  const word = /([A-Za-z.]+)\s*$/.exec(before)
  if (!word) return false
  return ORDINAL_WORDS.has(word[1].replace(/\.$/, '').toLowerCase())
}
