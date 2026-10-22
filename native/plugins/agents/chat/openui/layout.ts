// How an OpenUI doc adapts to the width it is given: how many columns a grid has, which siblings
// the window draws as a grid or a strip of metrics, when a row of children stacks, which slides a
// carousel shows. The widths are in pixels, so this is the terminal's cells (30 for a grid
// column) turned into what a window can fit. Plain functions, tested without a window.
import type { UiNode } from "@suite/protocol/types";
import { cellText, num, nodes, str, type Cell } from "./props";

/** The narrowest a grid column or carousel slide gets: 30 cells in a terminal. */
export const GRID_MIN = 240;

/** The narrowest a metric in a strip gets. */
export const METRIC_MIN = 150;

/** The `gap` of a Stack in pixels. */
export function gapPx(gap: string | undefined): number {
  switch (gap) {
    case "none":
      return 0;
    case "s":
      return 6;
    case "l":
      return 20;
    default:
      return 12;
  }
}

/** The room inside a card: its border and padding. */
export const CARD_PADDING = 14;

/** The width a card leaves its children, inside its padding and border. */
export function insideCard(width: number): number {
  return Math.max(0, width - (CARD_PADDING + 1) * 2);
}

/** How tall a card's cover picture is across `width`: 16:9, but never more than 240 pixels. */
export function coverHeight(width: number): number {
  return Math.round(Math.min(width * (9 / 16), 240));
}

/** How many columns of at least `min` fit in `width` with `gap` between, at most `max`. */
export function columnsFor(
  width: number,
  count: number,
  min: number,
  gap: number,
  max?: number,
): number {
  if (count <= 0) return 1;
  const fit = Math.max(1, Math.floor((width + gap) / (min + gap)));
  const cap = max !== undefined && max >= 1 ? Math.floor(max) : count;
  return Math.max(1, Math.min(fit, cap, count));
}

/** The width of one of `columns` equal columns in `width` with `gap` between. */
export function cellWidth(width: number, columns: number, gap: number): number {
  return Math.max(0, Math.floor((width - gap * (columns - 1)) / columns));
}

/** Items in rows of `columns`. */
export function chunk<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < items.length; at += Math.max(1, columns)) {
    rows.push(items.slice(at, at + Math.max(1, columns)));
  }
  return rows;
}

/** A child with the place it has in its parent's list, which names it in the doc's paths. */
export interface Placed {
  node: UiNode;
  index: number;
}

export type Segment =
  | { kind: "node"; at: Placed }
  | { kind: "cards"; items: Placed[] }
  | { kind: "metrics"; items: Placed[] }
  | { kind: "shapes"; items: Placed[] };

/**
 * The children of a column Stack, a Card, a Tab or an AccordionItem as the window draws them: a
 * run of two or more sibling Cards is a grid and a run of two or more Metrics a strip, whatever
 * the program says; a run of two or more Shapes is one canvas. Other siblings between them end a
 * run.
 */
export function segments(children: readonly UiNode[]): Segment[] {
  const out: Segment[] = [];
  let run: Placed[] = [];
  let runKind: "Card" | "Metric" | "Shape" | undefined;
  const end = (): void => {
    if (run.length >= 2 && runKind === "Card") out.push({ kind: "cards", items: run });
    else if (run.length >= 2 && runKind === "Metric") out.push({ kind: "metrics", items: run });
    else if (run.length >= 2 && runKind === "Shape") out.push({ kind: "shapes", items: run });
    else for (const at of run) out.push({ kind: "node", at });
    run = [];
    runKind = undefined;
  };
  children.forEach((node, index) => {
    const kind =
      node.component === "Card" || node.component === "Metric" || node.component === "Shape"
        ? node.component
        : undefined;
    if (kind === undefined || kind !== runKind) end();
    if (kind === undefined) {
      out.push({ kind: "node", at: { node, index } });
      return;
    }
    runKind = kind;
    run.push({ node, index });
  });
  end();
  return out;
}

const CHAR = 7.3;

/** A text's width on one line, near enough to decide whether things fit. */
export function textWidth(text: string, size = 14): number {
  return Math.ceil(text.length * size * 0.52) + (size > 14 ? 2 : 0);
}

/** The length of the longest word of a text, in characters. */
function longestWord(text: string): number {
  return Math.max(0, ...text.split(/\s+/).map((word) => word.length));
}

/** What a Link shows: its text, else its address. */
function linkText(node: UiNode): string {
  const text = str(node, "text");
  if (text !== undefined && text !== "") return text;
  return str(node, "url") ?? "";
}

/** The narrowest a node can be drawn at: what a row has to leave it. */
export function minWidthOf(node: UiNode): number {
  switch (node.component) {
    case "Tag":
      return textWidth(str(node, "label") ?? "", 12) + 20;
    case "Button":
      return textWidth(str(node, "label") ?? "", 14) + 28;
    case "Metric":
      return Math.max(METRIC_MIN - 30, textWidth(str(node, "label") ?? "", 12));
    case "MetricIndicator":
      return 90;
    case "Link":
      return Math.ceil(longestWord(linkText(node)) * CHAR);
    case "Text":
    case "Callout":
      return 60;
    case "Header":
      return 100;
    case "Separator":
      return 8;
    case "Box": {
      // A share or what is left shrinks with the row; the rest is as wide as its content.
      const ask = askOf(node);
      return ask === "fit" || ask === undefined ? GRID_MIN - 40 : 60;
    }
    case "Shape":
      return 60;
    case "Progress":
      return 100;
    case "Image":
      return 100;
    case "Sparkline":
      return 100;
    default:
      return GRID_MIN - 40;
  }
}

/** The inline components a row lets keep their own width; the rest share what is left. */
export function isInline(node: UiNode): boolean {
  switch (node.component) {
    case "Tag":
    case "Button":
    case "Metric":
    case "MetricIndicator":
    case "Link":
    case "Text":
    case "Header":
    case "Progress":
    case "Sparkline":
    case "Separator":
      return true;
    default:
      return false;
  }
}

/** What a Box asks of the width its parent has: all that is left, its content's, or a share of it. */
export type Ask = "fill" | "fit" | number;

/** The `width` of a Box; undefined for one without (a column fills, a row fits) and for the rest. */
export function askOf(node: UiNode): Ask | undefined {
  if (node.component !== "Box") return undefined;
  const value = node.props["width"];
  if (value === "fill" || value === "fit") return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(1, value);
  return undefined;
}

/** `share` of `room` pixels, at least one and never more than there is. */
export function shareWidth(share: number, room: number): number {
  return Math.min(Math.max(0, Math.floor(room)), Math.max(1, Math.round(room * share)));
}

/** Whether a row of children fits at their narrowest. */
export function rowFits(children: readonly UiNode[], width: number, gap: number): boolean {
  if (children.length <= 1) return true;
  const need = children.reduce((sum, child) => sum + minWidthOf(child), 0);
  return need + gap * (children.length - 1) <= width;
}

/** The slides a carousel shows: from `first`, as many as `visible`, fewer at the end. */
export function slideWindow(
  first: number,
  visible: number,
  count: number,
): { from: number; to: number } {
  const from = Math.min(Math.max(0, first), Math.max(0, count - 1));
  return { from, to: Math.min(count, from + Math.max(1, visible)) };
}

/** `2/5` or `2–3/5`: where a carousel is. */
export function slideLabel(window: { from: number; to: number }, count: number): string {
  const last = window.to - 1;
  const range = last > window.from ? `${window.from + 1}–${last + 1}` : String(window.from + 1);
  return `${range}/${count}`;
}

/** How many slides a carousel shows at this width: as many as fit, at most `visible`. */
export function slidesFor(
  width: number,
  count: number,
  visible: number | undefined,
  gap: number,
): number {
  return columnsFor(width, count, GRID_MIN, gap, visible);
}

/** How many option cards fit side by side: 22 to 34 cells in a terminal. */
export function cardsPerRow(width: number, count: number): number {
  return columnsFor(width, count, 190, 10);
}

/**
 * Whether an entity list is drawn with each subtitle under its title: when the titles, a little
 * of the subtitles and the trailing values do not fit in a row.
 */
export function entityStacked(
  items: readonly { title: string; subtitle?: string; trailing?: Cell }[],
  width: number,
): boolean {
  const title = Math.max(0, ...items.map((item) => textWidth(item.title)));
  const trailing = Math.max(
    0,
    ...items.map((item) => textWidth(cellText(item.trailing ?? ""), 13) + 24),
  );
  const subtitled = items.some((item) => item.subtitle !== undefined && item.subtitle !== "");
  return title + trailing + (subtitled ? 100 : 0) + 24 > width;
}

/** A Stack's direction. */
export function isRow(node: UiNode): boolean {
  return str(node, "direction") === "row";
}

/** `visible` of a Carousel. */
export function visibleOf(node: UiNode): number | undefined {
  return num(node, "visible");
}

/** The ordered children of a Tabs node: its Tab nodes. */
export function tabsOf(node: UiNode): UiNode[] {
  return nodes(node, "tabs");
}
