// Comments on changed lines, and the arithmetic over them: where a comment hangs, where it moves
// to when the file changes, how tall its card is, and the message that carries a batch of them to
// an agent. No host and no state, so it runs under `bun test`.

import type { Hunk } from "../diff/model";

/** One comment on the lines of a file. */
export interface ReviewComment {
  id: string;
  /** The file, from the worktree's root. */
  path: string;
  /** The first and last row of the lines commented on, counted from zero. The card hangs under the last. */
  startRow: number;
  endRow: number;
  /** The text of those lines when the comment was written, so the agent sees what it is about. */
  quoted: string[];
  text: string;
  /** Whether the lines it was written on can no longer be found in the file. */
  outdated: boolean;
  /** When it was written, in milliseconds since the epoch. */
  createdAt: number;
}

/** The rows a person commented on. */
export interface RowRange {
  startRow: number;
  endRow: number;
}

/** How far from its old place a comment's line is looked for when the file changes. */
export const REANCHOR_WINDOW = 100;

/** The characters of a line of a comment's card before it wraps. */
export const CARD_LINE_WIDTH = 96;

/** How many rows of the file a draft's input takes up: a line of hints and four lines to type in. */
export const DRAFT_ROWS = 5;

/**
 * The rows a selection covers. A selection that ends at the very start of a later line does not
 * take that line in, as when whole lines are selected by moving down.
 */
export function selectionRows(anchor: { row: number; column: number }, head: { row: number; column: number }): RowRange {
  let start = anchor;
  let end = head;
  if (head.row < anchor.row || (head.row === anchor.row && head.column < anchor.column)) {
    start = head;
    end = anchor;
  }
  let endRow = end.row;
  if (end.column === 0 && end.row > start.row) {
    endRow = end.row - 1;
  }
  return { startRow: start.row, endRow };
}

/** The rows of the new text that a diff changed or added, in order. A pure deletion has no row to comment on. */
export function commentableRows(hunks: readonly Hunk[]): number[] {
  const rows = new Set<number>();
  for (const hunk of hunks) {
    for (let offset = 0; offset < hunk.newLen; offset += 1) {
      rows.add(hunk.newStart + offset);
    }
  }
  return [...rows].sort((first, second) => first - second);
}

/** Whether every row of a range is a changed or added one. */
export function rangeIsCommentable(hunks: readonly Hunk[], range: RowRange): boolean {
  const rows = new Set(commentableRows(hunks));
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    if (!rows.has(row)) {
      return false;
    }
  }
  return true;
}

/** The lines of a file a range covers. */
export function quoteRows(lines: readonly string[], range: RowRange): string[] {
  return lines.slice(range.startRow, range.endRow + 1);
}

/** A comment on a range of a file's lines, which it quotes. */
export function newComment(id: string, path: string, range: RowRange, quoted: readonly string[], text: string, now: number): ReviewComment {
  return { id, path, startRow: range.startRow, endRow: range.endRow, quoted: [...quoted], text, outdated: false, createdAt: now };
}

/** Whether the lines of a file from a row on are the quoted ones. */
function quotesAt(lines: readonly string[], quoted: readonly string[], startRow: number): boolean {
  if (startRow < 0 || startRow + quoted.length > lines.length) {
    return false;
  }
  for (let offset = 0; offset < quoted.length; offset += 1) {
    if (lines[startRow + offset] !== quoted[offset]) {
      return false;
    }
  }
  return true;
}

/** The first row, nearest to `from` and within the window, where the quoted lines are in the file. */
function nearestQuote(lines: readonly string[], quoted: readonly string[], from: number): number | null {
  if (quotesAt(lines, quoted, from)) {
    return from;
  }
  if (quoted.every((line) => line.trim() === "")) {
    return null;
  }
  for (let distance = 1; distance <= REANCHOR_WINDOW; distance += 1) {
    if (quotesAt(lines, quoted, from - distance)) {
      return from - distance;
    }
    if (quotesAt(lines, quoted, from + distance)) {
      return from + distance;
    }
  }
  return null;
}

/**
 * Where a comment hangs after the file changed. The quoted lines are looked for near where they
 * were, and when they are found the comment follows them. When they are not, only the last of
 * them is looked for, so a comment on several lines survives an edit to one of the others. When
 * that is gone too the comment stays where it was, marked outdated, and is never dropped.
 */
export function reanchor(comment: ReviewComment, lines: readonly string[]): ReviewComment {
  const found = nearestQuote(lines, comment.quoted, comment.startRow);
  if (found !== null) {
    return placed(comment, found, false);
  }
  const lastQuoted = comment.quoted[comment.quoted.length - 1];
  const lastFound = nearestQuote(lines, [lastQuoted], comment.endRow);
  if (lastFound !== null) {
    return placed(comment, lastFound - (comment.quoted.length - 1), false, lastFound);
  }
  const lastRow = Math.max(0, lines.length - 1);
  const endRow = Math.min(comment.endRow, lastRow);
  const startRow = Math.max(0, endRow - (comment.endRow - comment.startRow));
  return { ...comment, startRow, endRow, outdated: true };
}

/** The comment at a row, outdated or not; `endRow` is given when it is not the quote's own. */
function placed(comment: ReviewComment, startRow: number, outdated: boolean, endRow?: number): ReviewComment {
  let end = endRow;
  if (end === undefined) {
    end = startRow + comment.quoted.length - 1;
  }
  return { ...comment, startRow: Math.max(0, startRow), endRow: end, outdated };
}

/** Re-anchors every comment on a file, and answers the same list when none of them moved. */
export function reanchorAll(comments: readonly ReviewComment[], lines: readonly string[]): ReviewComment[] {
  return comments.map((comment) => {
    const moved = reanchor(comment, lines);
    if (moved.startRow === comment.startRow && moved.endRow === comment.endRow && moved.outdated === comment.outdated) {
      return comment;
    }
    return moved;
  });
}

/** The comments of one file by the row their card hangs under, each row's in the order they were written. */
export function commentsByRow(comments: readonly ReviewComment[]): Map<number, ReviewComment[]> {
  const byRow = new Map<number, ReviewComment[]>();
  const ordered = [...comments].sort((first, second) => first.createdAt - second.createdAt);
  for (const comment of ordered) {
    const there = byRow.get(comment.endRow);
    if (there === undefined) {
      byRow.set(comment.endRow, [comment]);
      continue;
    }
    there.push(comment);
  }
  return byRow;
}

/** A text cut into lines of at most `width` characters, at spaces where it can, keeping the lines the person wrote. */
export function wrapText(text: string, width: number = CARD_LINE_WIDTH): string[] {
  const wrapped: string[] = [];
  for (const written of text.split("\n")) {
    wrapped.push(...wrapLine(written, width));
  }
  return wrapped;
}

/** One written line cut into lines of at most `width` characters. */
function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) {
      cut = width;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  pieces.push(rest);
  return pieces;
}

/** How many rows of the file a saved comment's card takes: a header, and its text. */
export function cardRows(comment: ReviewComment): number {
  return 1 + wrapText(comment.text).length;
}

/** "1 comment" or "3 comments". */
export function commentCount(count: number): string {
  if (count === 1) {
    return "1 comment";
  }
  return `${count} comments`;
}

/** "1 file" or "2 files". */
function fileCount(count: number): string {
  if (count === 1) {
    return "1 file";
  }
  return `${count} files`;
}

/** The lines a comment is on as people count them: `src/a.ts:12` or `src/a.ts:12-14`. */
export function placeOf(comment: ReviewComment): string {
  if (comment.startRow === comment.endRow) {
    return `${comment.path}:${comment.endRow + 1}`;
  }
  return `${comment.path}:${comment.startRow + 1}-${comment.endRow + 1}`;
}

/** The message an agent gets for a batch of comments, and the short text the chat shows in its place. */
export interface ReviewMessage {
  text: string;
  shown: string;
}

/** Writes the batch for the agent: every comment with its place, the lines it is on, and what was said. */
export function reviewMessage(comments: readonly ReviewComment[]): ReviewMessage {
  const ordered = [...comments].sort((first, second) => {
    if (first.path !== second.path) {
      return first.path.localeCompare(second.path);
    }
    return first.startRow - second.startRow;
  });
  const files = new Set(ordered.map((comment) => comment.path));
  const shown = `Review: ${commentCount(ordered.length)} on ${fileCount(files.size)}`;
  const lines = [`Review of your changes: ${commentCount(ordered.length)} on ${fileCount(files.size)}. Please address each one.`];
  for (const comment of ordered) {
    lines.push("", placeOf(comment), "```", ...comment.quoted, "```");
    if (comment.outdated) {
      lines.push("(The file has changed since; these lines may have moved or gone.)");
    }
    lines.push(comment.text);
  }
  return { text: lines.join("\n"), shown };
}

/** A fresh id for a comment. */
export function commentId(now: number, sequence: number): string {
  return `c${now.toString(36)}${sequence.toString(36)}`;
}

/** The height of a row of the editor's text, in pixels (`LINE_HEIGHT` in `src/editor/element.rs`). */
export const EDITOR_LINE_HEIGHT = 21;
