// What a diff component needs to draw its lines in syntax colours: the lines it shows, run through
// a highlighter, and which runs belong to which line.

import type { DiffLine } from "@suite/protocol/types";
import type { SyntaxStyle } from "../../theme/editorTheme";
import type { Highlighter, Run } from "../highlight";

/** The runs of each of the lines that are code (hunk headers are not), keyed by the line, or undefined while there are none. */
export async function highlightDiffLines(
  highlighter: Highlighter,
  lines: readonly DiffLine[],
  path: string | undefined,
  syntax: Record<string, SyntaxStyle>,
): Promise<ReadonlyMap<DiffLine, readonly Run[]> | undefined> {
  if (path === undefined) {
    return undefined;
  }
  const code = lines.filter((line) => line.kind !== "hunk");
  if (code.length === 0) {
    return undefined;
  }
  const runs = await highlighter.lines(code.map((line) => line.text).join("\n"), path, syntax);
  if (runs === undefined) {
    return undefined;
  }
  const byLine = new Map<DiffLine, readonly Run[]>();
  code.forEach((line, index) => {
    const lineRuns = runs[index];
    if (lineRuns !== undefined) {
      byLine.set(line, lineRuns);
    }
  });
  return byLine;
}
