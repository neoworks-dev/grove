// What the compare section compares. Set from the section's own pickers, or
// from a branch or tag's menu ("compare with HEAD"), which is why it lives
// outside any one component. A null head is the working tree.

export interface CompareTarget {
  base: string
  head: string | null
}

export const compareTarget = $state<{ current: CompareTarget | null; version: number }>({
  current: null,
  version: 0
})

/** Points the compare section at two refs; bumps `version` so it opens and scrolls to itself. */
export function compareRefs(base: string, head: string | null): void {
  compareTarget.current = { base, head }
  compareTarget.version += 1
}
