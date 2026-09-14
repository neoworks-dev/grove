// Fuzzy ranking for the file finder: a query matches a path when its characters
// appear in order (not necessarily adjacent), and the score rewards the matches
// a human means — runs of adjacent characters, segment starts, and the filename
// over the directories leading to it.

/** One candidate path with the score it earned for the current query. */
export interface RankedFile {
  path: string
  score: number
}

// Characters that end a path segment or a word inside one. A match landing
// right after one of these is what the user usually typed the letter for.
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

const ADJACENT_BONUS = 8
const BOUNDARY_BONUS = 6
const GAP_PENALTY = 0.5
const MAX_GAP_PENALTY = 3
// A filename hit outranks the same letters scattered through the directories.
const FILENAME_BONUS = 40

/**
 * Rank every path that fuzzy-matches the query, best first. An empty query
 * keeps the input order, which is already alphabetical.
 */
export function rankFiles(paths: string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return paths

  const ranked: RankedFile[] = []
  for (const path of paths) {
    const score = scoreCandidate(path, needle)
    if (score === null) continue
    ranked.push({ path, score })
  }

  ranked.sort(compareRanked)
  return ranked.map((entry) => entry.path)
}

/** Higher score first; equal scores fall back to the alphabetical order. */
function compareRanked(a: RankedFile, b: RankedFile): number {
  if (a.score !== b.score) return b.score - a.score
  return a.path.localeCompare(b.path)
}

/**
 * Best score for one path, or null when the query is not a subsequence of it.
 * The filename is tried first so `acomp` finds `AgentComposer.svelte` without
 * having to out-score the letters it could also pick up from the directories.
 */
export function scoreCandidate(path: string, needle: string): number | null {
  const filenameStart = path.lastIndexOf('/') + 1
  const filename = path.slice(filenameStart).toLowerCase()

  const filenameScore = subsequenceScore(filename, needle)
  if (filenameScore !== null) {
    return filenameScore + FILENAME_BONUS - lengthPenalty(path)
  }

  const pathScore = subsequenceScore(path.toLowerCase(), needle)
  if (pathScore === null) return null
  return pathScore - lengthPenalty(path)
}

/**
 * Greedy leftmost subsequence match. Returns null when a needle character has
 * no home left in the haystack.
 */
function subsequenceScore(haystack: string, needle: string): number | null {
  let score = 0
  let searchFrom = 0
  let previousIndex = -1

  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom)
    if (index < 0) return null
    score += characterScore(haystack, index, previousIndex)
    previousIndex = index
    searchFrom = index + 1
  }
  return score
}

/** What one matched character is worth, given where the previous one landed. */
function characterScore(haystack: string, index: number, previousIndex: number): number {
  let score = 1
  if (index === previousIndex + 1) score += ADJACENT_BONUS
  if (isSegmentStart(haystack, index)) score += BOUNDARY_BONUS

  if (previousIndex < 0) return score

  const gap = index - previousIndex - 1
  return score - Math.min(gap * GAP_PENALTY, MAX_GAP_PENALTY)
}

function isSegmentStart(haystack: string, index: number): boolean {
  if (index === 0) return true
  return BOUNDARY_CHARS.has(haystack[index - 1])
}

/** Ties break towards the shorter path: less unmatched noise around the hit. */
function lengthPenalty(path: string): number {
  return path.length / 100
}
