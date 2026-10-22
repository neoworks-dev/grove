// Small questions about view components that the chat's drawing code asks over and over. Plain
// TypeScript so they can be tested without a window.
import type { Component, Space, Tone } from "@suite/protocol/types";
import type { Palette } from "../palette";

/** Whether the component is, or contains, a button: such an item is a question to answer. */
export function hasButtons(component: Component): boolean {
  switch (component.type) {
    case "button":
      return true;
    case "card":
    case "row":
    case "stack":
      return component.children.some(hasButtons);
    default:
      return false;
  }
}

/** Whether the component is, or contains, a neoui doc: such an item is drawn open, as the result is the point of the call. */
export function hasDoc(component: Component): boolean {
  switch (component.type) {
    case "openui":
      return true;
    case "card":
    case "row":
    case "stack":
      return component.children.some(hasDoc);
    default:
      return false;
  }
}

/** The last part of a path (the whole of anything else). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** The colour a tone stands for. */
export function toneColor(tone: Tone, p: Palette): string {
  return p[tone];
}

/** Pixels between children for a component's `gap`. */
export function gapOf(gap: Space | undefined, p: Palette): number {
  return p.space[gap ?? "s"];
}

/** Line height for text of `size`: a little air, as in Claude Code's chat. */
export function lineHeightOf(size: number): number {
  return Math.round(size * 1.5);
}

/** Collapses whitespace and line breaks, for the one-line forms. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
