// How the GitHub pane words and colours things, as pure functions so they run under `bun test`.

import { relativeTime } from "../git-gutter/changes";
import type { CheckState, ItemState, ReviewState } from "./model";

/** The word an item's tag says. */
export function stateWord(state: ItemState): string {
  if (state === "open") {
    return "Open";
  }
  if (state === "closed") {
    return "Closed";
  }
  if (state === "merged") {
    return "Merged";
  }
  return "Draft";
}

/** The word for how a check stands. */
export function checkWord(state: CheckState): string {
  if (state === "passing") {
    return "Passing";
  }
  if (state === "failing") {
    return "Failing";
  }
  if (state === "skipped") {
    return "Skipped";
  }
  return "Running";
}

/** "1 check", "3 checks". */
export function checkCountWord(count: number): string {
  if (count === 1) {
    return "1 check";
  }
  return `${count} checks`;
}

/** The sentence for what a review decided. */
export function reviewWord(state: ReviewState): string {
  if (state === "approved") {
    return "approved";
  }
  if (state === "changes requested") {
    return "requested changes";
  }
  if (state === "dismissed") {
    return "had a review dismissed";
  }
  if (state === "pending") {
    return "has a pending review";
  }
  return "commented";
}

/** How long ago an ISO time was, or an empty string when it is not one. */
export function agoOf(iso: string, nowMilliseconds: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  return relativeTime(then, nowMilliseconds);
}

/** "1 comment", "3 comments". */
export function commentCount(count: number): string {
  if (count === 1) {
    return "1 comment";
  }
  return `${count} comments`;
}

/** The text and background colours of a label pill from the label's own colour (six hex digits). */
export function labelColors(hex: string, fallbackText: string): { text: string; background: string } {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return { text: fallbackText, background: "#ffffff1a" };
  }
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  let text = `#${hex}`;
  // A label colour too dark to read on the pane is drawn in the pane's own text colour.
  if (brightness < 90) {
    text = fallbackText;
  }
  return { text, background: `#${hex}2e` };
}
