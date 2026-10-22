import { expect, test } from "bun:test";
import type { UiNode } from "@suite/protocol/types";
import {
  firstButton,
  focusOrder,
  isInteractive,
  neighbour,
  type Disclosure,
} from "../plugins/agents/chat/openui/focus";
import { childPath } from "../plugins/agents/chat/openui/paths";

const node = (component: string, props: Record<string, unknown> = {}, key?: string): UiNode =>
  key === undefined ? { component, props } : { component, key, props };

const view = (
  tabs: Record<string, number> = {},
  open: Record<string, boolean> = {},
): Disclosure => ({
  tab: (path) => tabs[path] ?? 0,
  isOpen: (path, starts) => open[path] ?? starts,
});

const input = (key: string): UiNode => node("Input", { name: key }, key);

test("a form's targets are its fields and buttons in drawing order, and a node's path names the rest", () => {
  const form = node("Form", {
    name: "f",
    children: [
      node("FormControl", { label: "A", input: input("a") }),
      node("FormControl", { label: "B", input: node("Select", { options: [] }, "b") }),
    ],
    buttons: node("Buttons", { buttons: [node("Button", { label: "Go" }, "go")] }),
  });
  expect(focusOrder(form, view())).toEqual(["a", "b", "go"]);
  const dated = node("FormControl", {
    label: "When",
    input: node("DatePicker", { name: "when" }, "when"),
  });
  expect(focusOrder(dated, view())).toEqual(["when", "when/calendar"]);
  expect(childPath("/children.2", "tabs", 1)).toBe("/children.2/tabs.1");
  expect(childPath("", "input")).toBe("/input");
});

test("only the selected tab and the open accordion items are on the way", () => {
  const root = node("Stack", {
    children: [
      node("Tabs", {
        tabs: [
          node("Tab", { label: "One", children: [input("one")] }),
          node("Tab", { label: "Two", children: [input("two")] }),
        ],
      }),
      node("Accordion", {
        items: [
          node("AccordionItem", { title: "A", children: [input("inA")] }),
          node("AccordionItem", { title: "B", open: true, children: [input("inB")] }),
        ],
      }),
    ],
  });
  expect(focusOrder(root, view())).toEqual([
    "/children.0",
    "one",
    "/children.1/items.0",
    "/children.1/items.1",
    "inB",
  ]);
  expect(focusOrder(root, view({ "/children.0": 1 }, { "/children.1/items.0": true }))).toEqual([
    "/children.0",
    "two",
    "/children.1/items.0",
    "inA",
    "/children.1/items.1",
    "inB",
  ]);
});

test("a carousel with several slides is a target, one with a single slide is not", () => {
  const slides = (n: number): UiNode =>
    node("Carousel", { children: Array.from({ length: n }, () => node("Card", { children: [] })) });
  expect(focusOrder(slides(3), view())).toEqual([""]);
  expect(focusOrder(slides(1), view())).toEqual([]);
  expect(focusOrder(node("Tabs", { tabs: [] }), view())).toEqual([]);
});

test("follow-ups and buttons in a table cell or a list are found by their keys", () => {
  const root = node("FollowUpBlock", {
    items: [
      node("FollowUpItem", { text: "Why?" }, "f.0"),
      node("FollowUpItem", { text: "How?" }, "f.1"),
    ],
  });
  // A follow-up has no focus order of its own (it is not a form), but it has keys.
  expect(isInteractive(root)).toBe(true);
  expect(isInteractive(node("Card", { children: [node("Text")] }))).toBe(false);
  expect(isInteractive(undefined)).toBe(false);
});

test("Tab goes to the next target that is drawn and wraps round, Shift-Tab goes back", () => {
  const order = ["a", "b", "c"];
  const all = (): boolean => true;
  expect(neighbour(order, "a", 1, all)).toBe("b");
  expect(neighbour(order, "c", 1, all)).toBe("a");
  expect(neighbour(order, "a", -1, all)).toBe("c");
  // Nothing focused: forward starts at the first, back at the last.
  expect(neighbour(order, undefined, 1, all)).toBe("a");
  expect(neighbour(order, undefined, -1, all)).toBe("c");
  // What is not drawn is skipped.
  expect(neighbour(order, "a", 1, (id) => id !== "b")).toBe("c");
  expect(neighbour(order, "a", 1, () => false)).toBeUndefined();
  expect(neighbour([], "a", 1, all)).toBeUndefined();
  expect(neighbour(["a"], "a", 1, all)).toBeUndefined();
});

test("Enter presses the form's first button that can be pressed", () => {
  const form = node("Form", {
    children: [input("a")],
    buttons: node("Buttons", {
      buttons: [
        node("Button", { label: "Off", disabled: true }, "off"),
        node("Button", { label: "On" }, "on"),
        node("Button", { label: "Other" }, "other"),
      ],
    }),
  });
  expect(firstButton(form)?.key).toBe("on");
  expect(firstButton(node("Card", { children: [] }))).toBeUndefined();
  expect(firstButton(undefined)).toBeUndefined();
});
