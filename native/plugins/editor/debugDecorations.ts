// One decoration of each kind at a cursor, for checking by hand that the editor draws them and
// that they follow edits. Reached from the palette only (see `registerDebugCommands`).

import type { CursorInfo, Decoration } from "./service";

/** The name of the set the test decorations are in. */
export const DEBUG_SOURCE = "debug";

/** A squiggle under the next few characters, an inlay at the cursor, text after the line, a dot in the gutter and a block under the line. */
export function debugDecorations(cursor: CursorInfo): Decoration[] {
  const { row, column } = cursor;
  return [
    {
      kind: "highlight",
      start: { row, column },
      end: { row, column: column + 6 },
      background: "warning",
      underline: { style: "squiggle", tone: "error" },
    },
    { kind: "inlay", start: { row, column }, text: ": i32", tone: "hint" },
    { kind: "line_end", start: { row, column: 1_000_000 }, text: "error: expected `;` here", tone: "error" },
    { kind: "gutter", start: { row, column: 0 }, mark: "dot", tone: "error" },
    {
      kind: "block",
      start: { row, column: 0 },
      lines: ["debug block: two rows of text", "that sit between the lines"],
      placement: "below",
      tone: "info",
    },
  ];
}
