// Turns what git says about a file into decorations: the hunks of its diff against HEAD become
// bars in the gutter, and the commit behind a line becomes text after the line.

import type { Decoration } from "@neoworks/svelte-gpui-editor";

/** A changed stretch of a file, with lines counted from 1, as `@@ -oldStart,oldCount +newStart,newCount @@` gives it. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** How a file differs from HEAD. A file git does not track, or that is in no repository, has no hunks. */
export interface FileChanges {
  state: "clean" | "changed" | "untracked" | "outside";
  hunks: Hunk[];
}

/** The commit that last changed a line. `time` is in seconds since 1970. */
export interface Blame {
  hash: string;
  author: string;
  time: number;
  summary: string;
  committed: boolean;
}

/** A column far past any line's end, which the editor moves back onto the end of the line. */
export const END_OF_LINE = 1_000_000;

/** The name of the set the gutter bars belong to. */
export const CHANGES_SOURCE = "git.changes";

/** The name of the set the blame text belongs to. */
export const BLAME_SOURCE = "git.blame";

/**
 * The gutter marks for a diff. Added lines get a green bar, changed lines a blue one, and the
 * place where lines were deleted a red notch at the top of the line that follows.
 */
export function changeDecorations(hunks: Hunk[]): Decoration[] {
  return hunks.map(hunkDecoration);
}

/** The mark for one hunk. */
function hunkDecoration(hunk: Hunk): Decoration {
  if (hunk.newCount === 0) {
    return { kind: "gutter", start: { row: hunk.newStart, column: 0 }, mark: "notch", tone: "deleted" };
  }
  const firstRow = hunk.newStart - 1;
  const lastRow = firstRow + hunk.newCount - 1;
  const tone = hunk.oldCount === 0 ? "added" : "modified";
  return { kind: "gutter", start: { row: firstRow, column: 0 }, end: { row: lastRow, column: 0 }, mark: "bar", tone };
}

/** The text after a line that says who last changed it, when, and why. */
export function blameDecoration(row: number, blame: Blame, nowMilliseconds: number): Decoration {
  return { kind: "line_end", start: { row, column: END_OF_LINE }, text: blameText(blame, nowMilliseconds), tone: "line_end" };
}

/** The words of a blame line: "Ada Lovelace, 3 days ago • Add the engine". */
export function blameText(blame: Blame, nowMilliseconds: number): string {
  if (!blame.committed) {
    return "Not committed yet";
  }
  return `${blame.author}, ${relativeTime(blame.time * 1000, nowMilliseconds)} • ${blame.summary}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** How long before now a moment was, in the largest unit that fits: "just now", "5 minutes ago", "2 years ago". */
export function relativeTime(thenMilliseconds: number, nowMilliseconds: number): string {
  const seconds = Math.max(0, Math.floor((nowMilliseconds - thenMilliseconds) / 1000));
  if (seconds < MINUTE) {
    return "just now";
  }
  const units: [number, string][] = [
    [YEAR, "year"],
    [MONTH, "month"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
  ];
  for (const [length, name] of units) {
    if (seconds >= length) {
      const count = Math.floor(seconds / length);
      return `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
