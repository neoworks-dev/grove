// Which parts of a doc take the keyboard, in drawing order. A part is named by its node's `key`,
// or by its path (paths.ts) when it has none: a tab strip, an accordion item, a carousel.
import type { UiNode } from "@suite/protocol/types";
import { childPath } from "./paths";
import { isNode, nodes } from "./props";

/** The id of a date picker's calendar button. */
export function calendarId(key: string): string {
  return `${key}/calendar`;
}

/** What `focusOrder` needs of the doc's visual state. */
export interface Disclosure {
  tab(path: string): number;
  isOpen(path: string, starts: boolean): boolean;
}

/** Components with a key that take the keyboard. */
const FIELDS = new Set([
  "Input",
  "TextArea",
  "Select",
  "RadioGroup",
  "OptionCards",
  "CheckBox",
  "Switch",
  "CheckBoxGroup",
  "SwitchGroup",
  "Slider",
  "DatePicker",
  "Button",
]);

/**
 * The ids of what takes the keyboard, top to bottom: a node's `key`, or the path of a tab strip, an
 * accordion item or a carousel. What is hidden (another tab, a closed accordion item) is not there.
 */
export function focusOrder(root: UiNode, view: Disclosure): string[] {
  const out: string[] = [];
  walk(root, "", view, out);
  return out;
}

function walk(node: UiNode, path: string, view: Disclosure, out: string[]): void {
  if (node.key !== undefined && FIELDS.has(node.component)) out.push(node.key);
  // The button beside a date's text field is a stop of its own.
  if (node.key !== undefined && node.component === "DatePicker") out.push(calendarId(node.key));
  if (node.component === "Tabs") {
    const tabs = nodes(node, "tabs");
    if (tabs.length === 0) return;
    out.push(path);
    const at = Math.min(Math.max(0, view.tab(path)), tabs.length - 1);
    const tab = tabs[at];
    if (tab !== undefined) walkChildren(tab, childPath(path, "tabs", at), view, out);
    return;
  }
  if (node.component === "Accordion") {
    nodes(node, "items").forEach((item, index) => {
      const at = childPath(path, "items", index);
      out.push(at);
      if (view.isOpen(at, item.props["open"] === true)) walkChildren(item, at, view, out);
    });
    return;
  }
  if (node.component === "Carousel" && nodes(node, "children").length >= 2) out.push(path);
  walkChildren(node, path, view, out);
}

function walkChildren(node: UiNode, path: string, view: Disclosure, out: string[]): void {
  for (const [prop, value] of Object.entries(node.props)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isNode(entry)) walk(entry, childPath(path, prop, index), view, out);
      });
    } else if (isNode(value)) {
      walk(value, childPath(path, prop), view, out);
    }
  }
}

/** The id after (or, with `by` -1, before) `current` in the order, wrapping round; `usable` skips what is not drawn. */
export function neighbour(
  order: readonly string[],
  current: string | undefined,
  by: 1 | -1,
  usable: (id: string) => boolean,
): string | undefined {
  const count = order.length;
  if (count === 0) return undefined;
  const at = current === undefined ? -1 : order.indexOf(current);
  // With nothing focused, going forward starts before the first and going back after the last.
  let origin = at;
  if (at < 0) origin = by > 0 ? -1 : count;
  for (let step = 1; step <= count; step += 1) {
    const index = (((origin + by * step) % count) + count) % count;
    const id = order[index];
    if (id !== undefined && id !== current && usable(id)) return id;
  }
  return undefined;
}

/** Whether a doc has anything to type into or press: a field or a button. */
export function isInteractive(root: UiNode | undefined): boolean {
  if (root === undefined) return false;
  if (root.key !== undefined) return true;
  for (const value of Object.values(root.props)) {
    if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry) && isInteractive(entry)) return true;
    } else if (isNode(value) && isInteractive(value)) {
      return true;
    }
  }
  return false;
}

/** The first button under a node that can be pressed. */
export function firstButton(root: UiNode | undefined): UiNode | undefined {
  if (root === undefined) return undefined;
  if (root.component === "Button" && root.key !== undefined && root.props["disabled"] !== true) {
    return root;
  }
  for (const value of Object.values(root.props)) {
    const found = firstIn(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstIn(value: unknown): UiNode | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = isNode(entry) ? firstButton(entry) : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return isNode(value) ? firstButton(value) : undefined;
}
