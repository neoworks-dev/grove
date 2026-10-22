// Parsed markdown as a flat list of rows. Nesting (a list in a list item, a quote around a
// list) becomes numbers on each row, so the chat draws it without nested components: the host
// runs the app on a small JavaScript stack, and every level of component nesting spends a lot of it.
import type { Block, ListBlock, Span, UiDoc } from "@suite/protocol/types";

/** How far a row sits below the previous one. */
export type RowGap = "none" | "tight" | "loose";

/** A list item's marker, drawn in the columns [at, at + width) in front of the item's first line. */
export interface Marker {
  text: string;
  at: number;
  width: number;
  /** A ticked task. */
  done: boolean;
}

interface RowBase {
  /** Characters before the text starts: the markers of the enclosing list items. */
  indent: number;
  markers: Marker[];
  /** How many quotes enclose the row: each gets a bar down the left. */
  quote: number;
  gap: RowGap;
}

export type MarkdownRow = RowBase &
  (
    | { kind: "paragraph"; spans: readonly Span[] }
    | { kind: "heading"; level: number; spans: readonly Span[] }
    | { kind: "code"; code: string }
    | { kind: "rule" }
    | { kind: "openui"; ui: UiDoc }
  );

interface Context {
  indent: number;
  quote: number;
  /** Inside a list item: blocks stack with a small gap. */
  tight: boolean;
}

function markerText(list: ListBlock, index: number): string {
  const checked = list.items[index]?.checked;
  if (checked !== undefined) return checked ? "✓" : "○";
  return list.ordered ? `${(list.start ?? 1) + index}.` : "•";
}

function flattenList(list: ListBlock, context: Context, out: MarkdownRow[]): void {
  const texts = list.items.map((_, index) => markerText(list, index));
  // The widest marker and a space: item text lines up whatever the marker.
  const width = Math.max(...texts.map((text) => text.length), 0) + 1;
  list.items.forEach((item, index) => {
    const start = out.length;
    const inner = { indent: context.indent + width, quote: context.quote, tight: true };
    flatten(item.blocks, inner, out);
    if (out.length === start) {
      out.push({ ...inner, kind: "paragraph", spans: [], markers: [], gap: "none" });
    }
    const first = out[start];
    if (first === undefined) return;
    first.markers.unshift({
      text: texts[index] ?? "",
      at: context.indent,
      width,
      done: item.checked === true,
    });
    if (index > 0) first.gap = "tight";
  });
}

function flatten(blocks: readonly Block[], context: Context, out: MarkdownRow[]): void {
  blocks.forEach((block, index) => {
    const start = out.length;
    const base = {
      indent: context.indent,
      quote: context.quote,
      markers: [],
      gap: "none" as RowGap,
    };
    switch (block.type) {
      case "paragraph":
        out.push({ ...base, kind: "paragraph", spans: block.spans });
        break;
      case "heading":
        out.push({ ...base, kind: "heading", level: block.level, spans: block.spans });
        break;
      case "code_block":
        out.push({ ...base, kind: "code", code: block.code });
        break;
      case "rule":
        out.push({ ...base, kind: "rule" });
        break;
      case "openui":
        out.push({ ...base, kind: "openui", ui: block.ui });
        break;
      case "quote":
        flatten(block.blocks, { ...context, quote: context.quote + 1 }, out);
        break;
      case "list":
        flattenList(block, context, out);
        break;
    }
    const first = out[start];
    if (first !== undefined && index > 0) first.gap = context.tight ? "tight" : "loose";
  });
}

/** The rows of a markdown text, top to bottom. */
export function markdownRows(blocks: readonly Block[]): MarkdownRow[] {
  const out: MarkdownRow[] = [];
  flatten(blocks, { indent: 0, quote: 0, tight: false }, out);
  return out;
}

/** What stands in front of a row's text, left to right: a gap of `chars` characters, or a marker. */
export interface IndentCell {
  chars: number;
  marker?: Marker;
}

export function indentCells(row: Pick<MarkdownRow, "indent" | "markers">): IndentCell[] {
  const cells: IndentCell[] = [];
  let cursor = 0;
  for (const marker of row.markers) {
    if (marker.at > cursor) cells.push({ chars: marker.at - cursor });
    cells.push({ chars: marker.width, marker });
    cursor = marker.at + marker.width;
  }
  if (row.indent > cursor) cells.push({ chars: row.indent - cursor });
  return cells;
}
