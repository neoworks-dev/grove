// How a run of inline markdown (a Span) looks: the style of one nested `Text`.
import type { Span } from "@suite/protocol/types";
import type { Palette } from "../palette";

/** The part of svelte-gpui's `Style` a run uses (this file is also checked without the library). */
export interface RunStyle {
  fontWeight?: "bold";
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  fontFamily?: string;
  fontSize?: number;
  background?: string;
  color?: string;
}

/** The style that makes a span's text what the agent wrote: bold, italic, code, a link. */
export function spanStyle(span: Span, p: Palette): RunStyle {
  const style: RunStyle = {};
  if (span.bold) style.fontWeight = "bold";
  if (span.italic) style.italic = true;
  if (span.strike) style.strikethrough = true;
  if (span.code) {
    style.fontFamily = "mono";
    style.fontSize = p.text.code;
    style.background = p.surface;
  }
  if (isLink(span)) {
    style.color = p.accent;
    style.underline = true;
  }
  return style;
}

/** Spans with a target. The run can't be pressed (nested text has no events), so see `linkHint`. */
export function isLink(span: Span): boolean {
  return span.href !== undefined && span.href !== "";
}

/** The address to show after a link's text, unless the text already is the address. */
export function linkHint(span: Span): string | undefined {
  if (!isLink(span) || span.href === span.text) return undefined;
  return span.href;
}
