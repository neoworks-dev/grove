// What a diff view is asked to show, and the arithmetic over its hunks. No host and no state, so
// it runs under `bun test`.

/** A changed stretch: the old lines were replaced by the new ones, with rows counted from zero. */
export interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}

/** How a diff is laid out: the removed lines between the new ones, or the old text beside the new. */
export type DiffMode = "inline" | "split";

/**
 * What the old side of a file's diff is. `head` and `index` compare the file with the commit or
 * the index; `staged` compares the index with the commit, which is what a commit would contain;
 * a text is anything else, such as what an agent started from.
 */
export type DiffBase = "head" | "index" | "staged" | { text: string; label: string };

/** What the old side is called in the diff tab's strip. */
export function baseLabel(base: DiffBase): string {
  if (base === "head") {
    return "HEAD";
  }
  if (base === "index") {
    return "Index";
  }
  if (base === "staged") {
    return "Staged";
  }
  return base.label;
}

/** The hunk a row of the new text belongs to. A deletion belongs to the row after it. */
export function hunkAtRow(hunks: Hunk[], row: number): Hunk | null {
  for (const hunk of hunks) {
    if (hunk.newLen === 0 && hunk.newStart === row) {
      return hunk;
    }
    if (row >= hunk.newStart && row < hunk.newStart + hunk.newLen) {
      return hunk;
    }
  }
  return null;
}

/**
 * The row to go to for the next hunk after `row` (step 1) or the previous one before it (step
 * -1), wrapping round at the ends. Null when there are no hunks. A hunk the row is inside counts
 * as being at its first row, so the next hunk is always another one.
 */
export function stepHunkRow(hunks: Hunk[], row: number, step: 1 | -1): number | null {
  if (hunks.length === 0) {
    return null;
  }
  const starts = hunks.map((hunk) => hunk.newStart).sort((first, second) => first - second);
  if (step === 1) {
    const after = starts.find((start) => start > row);
    if (after === undefined) {
      return starts[0];
    }
    return after;
  }
  const containing = hunkAtRow(hunks, row);
  let from = row;
  if (containing !== null) {
    from = containing.newStart;
  }
  const before = starts.filter((start) => start < from);
  if (before.length === 0) {
    return starts[starts.length - 1];
  }
  return before[before.length - 1];
}

/** "2 of 5" for the hunk a row is in, for the diff tab's strip; empty when the row is in none. */
export function hunkPosition(hunks: Hunk[], row: number): string {
  const containing = hunkAtRow(hunks, row);
  if (containing === null) {
    return "";
  }
  const ordered = [...hunks].sort((first, second) => first.newStart - second.newStart);
  return `${ordered.indexOf(containing) + 1} of ${hunks.length}`;
}

/** How many lines the hunks add and remove; a changed line counts as one of each. */
export function lineCounts(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.newLen;
    removed += hunk.oldLen;
  }
  return { added, removed };
}
