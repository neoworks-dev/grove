// The collapsed form of a tool result: a few lines under the item's header, as the terminal
// app shows it. The result is flattened into leaves (a card's title, a text, some code, a
// diff…) and the line budget is shared out so that every leaf gets a line before any gets a
// second: the `Exit code 1` after a screenful of output is not cut off. A leaf that is cut is
// followed by `… +N lines`.
import type {
  Block,
  Component,
  DiffComponent,
  ImageComponent,
  KvItem,
  Span,
  Tone,
} from "@suite/protocol/types";
import { oneLine } from "./components";
import { diffStats } from "./diff";

/** Lines shown before anything is cut (the `… +N lines` markers come on top). */
export const BUDGET = 3;

/** A line of text flattened out of markdown blocks. */
export interface TextLine {
  spans: Span[];
  /** Code blocks are drawn in the code font. */
  mono: boolean;
  /** The list marker or quote bar in front of it. */
  prefix: string;
}

export type SummaryLeaf =
  | { kind: "title"; title: string; tone?: Tone }
  | { kind: "code"; lines: string[] }
  | { kind: "text"; lines: TextLine[] }
  | { kind: "diff"; path: string; added: number; removed: number; component: DiffComponent }
  | { kind: "kv"; items: KvItem[] }
  | { kind: "line"; text: string }
  | { kind: "image"; component: ImageComponent }
  | { kind: "other"; component: Component }
  | { kind: "more"; count: number };

type Leaf = { title: string; tone?: Tone } | Component;

function isTitle(leaf: Leaf): leaf is { title: string; tone?: Tone } {
  return !("type" in leaf);
}

function leavesOf(component: Component, out: Leaf[]): void {
  switch (component.type) {
    case "card": {
      const title = oneLine(component.title ?? "");
      if (title !== "") out.push({ title, tone: component.tone });
      for (const child of component.children) leavesOf(child, out);
      break;
    }
    case "row":
    case "stack":
      for (const child of component.children) leavesOf(child, out);
      break;
    default:
      out.push(component);
  }
}

/** Markdown blocks as lines, one per paragraph, list item or code line. */
export function textLines(blocks: readonly Block[]): TextLine[] {
  const out: TextLine[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        out.push({ spans: block.spans, mono: false, prefix: "" });
        break;
      case "heading":
        out.push({
          spans: block.spans.map((span) => ({ ...span, bold: true })),
          mono: false,
          prefix: "",
        });
        break;
      case "code_block":
        for (const line of block.code.replace(/\n+$/, "").split("\n")) {
          out.push({ spans: [{ text: line }], mono: true, prefix: "" });
        }
        break;
      case "quote":
        for (const line of textLines(block.blocks)) {
          out.push({ ...line, prefix: `│ ${line.prefix}` });
        }
        break;
      case "list":
        block.items.forEach((item, index) => {
          let marker = block.ordered ? `${(block.start ?? 1) + index}. ` : "• ";
          if (item.checked !== undefined) marker = item.checked ? "[x] " : "[ ] ";
          textLines(item.blocks).forEach((line, i) => {
            const lead = i === 0 ? marker : " ".repeat(marker.length);
            out.push({ ...line, prefix: lead + line.prefix });
          });
        });
        break;
      case "rule":
        break;
    }
  }
  return out;
}

/** Lines of text with their line breaks as the agent wrote them, without a trailing break. */
function codeLines(code: string): string[] {
  const text = code.replace(/\n+$/, "");
  if (text.trim() === "") return [];
  return text.split("\n");
}

interface Shaped {
  leaf: SummaryLeaf;
  /** How many lines the leaf has in all. */
  total: number;
  /** How many of them `leaf` shows. */
  used: number;
}

function shape(leaf: Leaf, available: number): Shaped | undefined {
  if (isTitle(leaf)) {
    return { leaf: { kind: "title", title: leaf.title, tone: leaf.tone }, total: 1, used: 1 };
  }
  switch (leaf.type) {
    case "code": {
      const lines = codeLines(leaf.code);
      const shown = lines.slice(0, available);
      return { leaf: { kind: "code", lines: shown }, total: lines.length, used: shown.length };
    }
    case "text": {
      const lines = textLines(leaf.blocks);
      const shown = lines.slice(0, available);
      return { leaf: { kind: "text", lines: shown }, total: lines.length, used: shown.length };
    }
    case "diff": {
      const stats = diffStats(leaf.lines);
      const path = leaf.path === undefined ? "diff" : oneLine(leaf.path) || "diff";
      return { leaf: { kind: "diff", path, ...stats, component: leaf }, total: 1, used: 1 };
    }
    case "kv":
      return { leaf: { kind: "kv", items: leaf.items }, total: 1, used: 1 };
    case "table": {
      const rows = leaf.rows.length === 1 ? "1 row" : `${leaf.rows.length} rows`;
      const columns = leaf.columns.map(oneLine).join(", ");
      const text = columns === "" ? rows : `${rows} · ${columns}`;
      return { leaf: { kind: "line", text }, total: 1, used: 1 };
    }
    default:
      // Files, links, progress bars and buttons are short already.
      return { leaf: { kind: "other", component: leaf }, total: 1, used: 1 };
  }
}

/** The leaves to draw for a collapsed result, within `budget` lines (pictures cost none). */
export function summarize(component: Component, budget = BUDGET): SummaryLeaf[] {
  const leaves: Leaf[] = [];
  leavesOf(component, leaves);
  const out: SummaryLeaf[] = [];
  let shown = 0;
  let dropped = 0;
  leaves.forEach((leaf, index) => {
    if (!isTitle(leaf) && leaf.type === "image") {
      out.push({ kind: "image", component: leaf });
      return;
    }
    const room = budget - shown;
    const later = leaves.slice(index + 1).filter((l) => isTitle(l) || l.type !== "image").length;
    // Every later leaf keeps a line for itself; this one may use the rest, but at least one.
    const available = Math.max(Math.max(room - later, 0), Math.min(room, 1));
    const shaped = shape(leaf, available);
    if (shaped === undefined) return;
    if (available === 0) {
      dropped += shaped.total;
      return;
    }
    shown += shaped.used;
    if (shaped.used > 0) out.push(shaped.leaf);
    if (shaped.total > shaped.used) out.push({ kind: "more", count: shaped.total - shaped.used });
  });
  if (dropped > 0) out.push({ kind: "more", count: dropped });
  return out;
}
