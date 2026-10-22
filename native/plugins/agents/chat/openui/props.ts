// Reading the props of an evaluated OpenUI node (docs/openui.md). Props are concrete JSON of any
// shape the model produced, so every read checks the type and falls back to nothing.
import type { Block, Tone, UiNode } from "@suite/protocol/types";

const TONES: readonly string[] = ["accent", "muted", "success", "danger"];

/** Whether a prop value is a node of the tree. */
export function isNode(value: unknown): value is UiNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { component?: unknown }).component === "string"
  );
}

/** The value as an object, or nothing for anything else. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string prop; numbers are taken as their text. */
export function str(node: UiNode, name: string): string | undefined {
  const value = node.props[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A number prop. */
export function num(node: UiNode, name: string): number | undefined {
  const value = node.props[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A boolean prop. */
export function bool(node: UiNode, name: string): boolean | undefined {
  const value = node.props[name];
  return typeof value === "boolean" ? value : undefined;
}

/** A tone prop, if it names one of the four tones. */
export function tone(node: UiNode, name = "tone"): Tone | undefined {
  const value = node.props[name];
  return typeof value === "string" && TONES.includes(value) ? (value as Tone) : undefined;
}

/** A prop that is a list; anything else is an empty list. */
export function list(node: UiNode, name: string): unknown[] {
  const value = node.props[name];
  if (Array.isArray(value)) return value;
  return [];
}

/** The child nodes under a prop (`children`, `tabs`, `items`), skipping what is not a node. */
export function nodes(node: UiNode, name: string): UiNode[] {
  return list(node, name).filter(isNode);
}

/** A prop that is one node (`input` of a FormControl, `buttons` of a Form, `trailing` of a ListItem). */
export function child(node: UiNode, name: string): UiNode | undefined {
  const value = node.props[name];
  return isNode(value) ? value : undefined;
}

/** The numbers of a list prop (`values` of a series); a cell that is not a number is 0. */
export function numbers(node: UiNode, name: string): number[] {
  return list(node, name).map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0,
  );
}

/** The texts of a list prop; a cell that is not text is its text form, or nothing. */
export function strings(node: UiNode, name: string): string[] {
  return list(node, name).map((value) => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  });
}

/** The parsed markdown the daemon adds to `Text` and `Callout`. */
export function blocks(node: UiNode): Block[] {
  const value = node.props["blocks"];
  if (Array.isArray(value)) return value as Block[];
  return [];
}

/** A table cell, list item or trailing value that is a plain value or a node. */
export type Cell = string | UiNode;

/** A cell of a table, list or trailing slot: a node, or the value as text. */
export function cellOf(value: unknown): Cell {
  if (isNode(value)) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** The rows of a Table: lists of cells. */
export function rows(node: UiNode, name = "rows"): Cell[][] {
  return list(node, name).map((row) => {
    if (!Array.isArray(row)) return [];
    return row.map(cellOf);
  });
}

/** What a link shows: its text, else its address. */
function linkLabel(node: UiNode): string {
  const text = str(node, "text");
  if (text !== undefined) return text;
  return str(node, "url") ?? "";
}

/** The text a cell shows when it is not drawn as a node: for sizing columns and copying. */
export function cellText(cell: Cell): string {
  if (typeof cell === "string") return cell;
  switch (cell.component) {
    case "Tag":
      return str(cell, "label") ?? "";
    case "Link":
      return linkLabel(cell);
    case "MetricIndicator":
      return [str(cell, "value"), str(cell, "delta"), str(cell, "subtext")]
        .filter((part) => part !== undefined)
        .join(" ");
    case "Text":
      return blocks(cell)
        .flatMap((block) => {
          if (block.type !== "paragraph") return [];
          return block.spans.map((s) => s.text);
        })
        .join("");
    default:
      return "";
  }
}

/** Options of a Select, RadioGroup or OptionCards: their value, label and description. */
export interface Choice {
  value: string;
  label: string;
  description?: string;
}

/** The label an option shows: its title, else its label, else its value. */
function labelOf(option: UiNode, value: string): string {
  const title = str(option, "title");
  if (title !== undefined) return title;
  return str(option, "label") ?? value;
}

/** The options of a Select, RadioGroup or OptionCards. */
export function choices(node: UiNode, name = "options"): Choice[] {
  return nodes(node, name).map((option) => {
    const value = str(option, "value") ?? "";
    // An OptionCard has a title, an Option a label.
    return {
      value,
      label: labelOf(option, value),
      description: str(option, "description"),
    };
  });
}

/** Items of a CheckBoxGroup or SwitchGroup. */
export interface GroupItem {
  name: string;
  label: string;
  description?: string;
}

/** The items of a CheckBoxGroup or SwitchGroup. */
export function groupItems(node: UiNode): GroupItem[] {
  return nodes(node, "items").map((item) => {
    const name = str(item, "name") ?? "";
    return { name, label: str(item, "label") ?? name, description: str(item, "description") };
  });
}

/** Whether the value is an object: a SwitchGroup's `name to on/off`. */
export function flags(value: unknown): Record<string, boolean> {
  const map = record(value) ?? {};
  const out: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(map)) if (typeof on === "boolean") out[name] = on;
  return out;
}
