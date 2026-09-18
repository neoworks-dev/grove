// The branch an issue gets when Grove opens a worktree for it.
//
// CLAUDE.md already names the shape — `<issue-number>-<slug>`, written out by
// hand every time — so this is that rule applied to whatever the title happens
// to be. Kept pure and here, because "what does this issue's branch get called"
// is worth pinning by test rather than discovering from a directory listing.

/** How much of the title the slug keeps: long enough to read, short to type. */
const MAX_SLUG_LENGTH = 40

/**
 * A title as a branch-safe slug: lowercase words joined by hyphens, cut at a
 * word boundary rather than mid-word. Empty when the title has nothing a branch
 * name can carry — punctuation and emoji alone.
 */
export function slugify(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0)

  const kept: string[] = []
  let length = 0
  for (const word of words) {
    let next = word.length
    if (length > 0) next = length + 1 + word.length
    if (kept.length > 0 && next > MAX_SLUG_LENGTH) break
    kept.push(word)
    length = next
  }
  return kept.join('-').slice(0, MAX_SLUG_LENGTH)
}

/** The branch name for an issue, as the repository's own convention has it. */
export function branchNameFor(number: number, title: string): string {
  const slug = slugify(title)
  if (slug.length === 0) return String(number)
  return `${number}-${slug}`
}
