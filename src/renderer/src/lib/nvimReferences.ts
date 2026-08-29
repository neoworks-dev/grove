// Normalizes reference locations returned by Neovim's LSP clients before the
// references overlay consumes them. Multiple clients may report the same
// location, so deduplication happens at this boundary rather than in the UI.

export interface NvimReference {
  path: string
  uri: string
  line: number // 0-based
  col: number // 0-based in the client's offset encoding
  endLine: number
  endCol: number
  encoding: string
}

/** Validate, deduplicate, and order the open-string RPC payload from Neovim. */
export function normalizeNvimReferences(value: unknown): NvimReference[] {
  if (!Array.isArray(value)) return []

  const references: NvimReference[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<Record<keyof NvimReference, unknown>>
    if (
      typeof candidate.path !== 'string' ||
      candidate.path === '' ||
      typeof candidate.uri !== 'string' ||
      candidate.uri === '' ||
      typeof candidate.encoding !== 'string' ||
      candidate.encoding === '' ||
      !isPosition(candidate.line, candidate.col) ||
      !isPosition(candidate.endLine, candidate.endCol)
    ) {
      continue
    }
    const key = `${candidate.uri}\0${candidate.line}\0${candidate.col}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push(candidate as NvimReference)
  }

  return references.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.col - right.col
  )
}

function isPosition(line: unknown, col: unknown): boolean {
  return (
    typeof line === 'number' &&
    Number.isInteger(line) &&
    line >= 0 &&
    typeof col === 'number' &&
    Number.isInteger(col) &&
    col >= 0
  )
}

/** Match the overlay query against both file locations and the referenced symbol. */
export function referenceMatchesQuery(
  reference: NvimReference,
  query: string,
  symbol = ''
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack =
    `${reference.path}:${reference.line + 1}:${reference.col + 1} ${symbol}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
