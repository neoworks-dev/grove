// Which transcript section a seq falls in, for scrolling to a turn.

/**
 * The section a seq falls in: the last one starting at or before it. Sections
 * are keyed and start at the seq of their first item.
 */
export function sectionHolding(
  sections: readonly { key: string; startSeq: number | null }[],
  seq: number
): string | null {
  let found: string | null = null
  for (const section of sections) {
    if (section.startSeq === null) continue
    if (section.startSeq > seq) break
    found = section.key
  }
  return found
}
