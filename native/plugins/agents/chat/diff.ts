// A diff component's lines as the chat draws them: counted, cut to a preview, and (for the
// side-by-side overlay) aligned into rows with the old text on the left and the new on the right.
import type { DiffLine } from "@suite/protocol/types";

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }
  return { added, removed };
}

/**
 * The first `limit` items and how many were left out. A hint saying "N more" takes a line
 * itself, so cutting a single line would save nothing: then everything is kept.
 */
export function clip<T>(
  items: readonly T[],
  limit: number,
): { shown: readonly T[]; hidden: number } {
  if (items.length <= limit + 1) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/** One side of a side-by-side row. */
export interface SideCell {
  kind: "context" | "add" | "remove";
  /** Line number in that side's text. */
  no?: number;
  text: string;
}

export type SideRow =
  { kind: "hunk"; text: string } | { kind: "pair"; left?: SideCell; right?: SideCell };

/**
 * Lines laid out for two columns. Context shows on both sides. A change (the removed and added
 * lines between two stretches of context) pairs its removed lines with its added lines from the
 * top, so a rewritten line sits opposite its old version; whichever side has more leaves the
 * other side empty for the rest.
 */
export function sideBySide(lines: readonly DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let removed: SideCell[] = [];
  let added: SideCell[] = [];

  const flush = (): void => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i += 1) {
      rows.push({ kind: "pair", left: removed[i], right: added[i] });
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    switch (line.kind) {
      case "remove":
        removed.push({ kind: "remove", no: line.old, text: line.text });
        break;
      case "add":
        added.push({ kind: "add", no: line.new, text: line.text });
        break;
      case "hunk":
        flush();
        rows.push({ kind: "hunk", text: line.text });
        break;
      case "context":
        flush();
        rows.push({
          kind: "pair",
          left: { kind: "context", no: line.old, text: line.text },
          right: { kind: "context", no: line.new, text: line.text },
        });
        break;
    }
  }
  flush();
  return rows;
}

/** Width in characters of the line-number column for these lines. */
export function gutterWidth(lines: readonly DiffLine[]): number {
  let widest = 1;
  for (const line of lines) {
    for (const no of [line.old, line.new]) {
      if (no !== undefined) widest = Math.max(widest, String(no).length);
    }
  }
  return widest;
}
