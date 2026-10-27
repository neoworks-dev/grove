// How the messages waiting behind a running turn are listed above the input. Plain functions, so
// they are tested without a window. Ported from neo term (apps/term draw_waiting).

import type { WaitingInput } from "@suite/protocol/types";

/** Most rows the list takes; more messages than that end in a count. */
export const QUEUED_ROWS = 3;

/** What the list shows: a row per message that fits, and how many were left out. */
export interface QueuedRows {
  shown: string[];
  hidden: number;
}

/** The row of one message: its first line, an ellipsis when more follow, and a note for pictures. */
export function queuedRow(input: WaitingInput): string {
  const lines = input.text.split("\n").filter((line) => line.trim() !== "");
  let row = "";
  if (lines.length > 0) {
    row = lines[0].trim();
  }
  if (lines.length > 1) {
    row += " …";
  }
  const images = input.images;
  if (images !== undefined && images.length === 1) {
    row += "  [image]";
  } else if (images !== undefined && images.length > 1) {
    row += `  [${images.length} images]`;
  }
  return row;
}

/** The list for the waiting messages, oldest first; the last row counts the ones that do not fit. */
export function queuedRows(waiting: readonly WaitingInput[]): QueuedRows {
  let room = QUEUED_ROWS;
  if (waiting.length > QUEUED_ROWS) {
    room = QUEUED_ROWS - 1;
  }
  const hidden = Math.max(0, waiting.length - room);
  return { shown: waiting.slice(0, room).map(queuedRow), hidden };
}
