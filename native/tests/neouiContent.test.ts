import { expect, test } from "bun:test";
import type { UiNode } from "@suite/protocol/types";
import {
  isNumeric,
  marker,
  numericColumns,
  progressLabel,
  tableWeights,
} from "../plugins/agents/chat/openui/content";
import {
  cellText,
  choices,
  groupItems,
  isNode,
  nodes,
  numbers,
  rows,
  str,
  strings,
  tone,
} from "../plugins/agents/chat/openui/props";

const node = (component: string, props: Record<string, unknown> = {}): UiNode => ({
  component,
  props,
});

test("a progress bar says its percentage and the label unless the label says it already", () => {
  expect(progressLabel(0.72, "used")).toBe("72% used");
  expect(progressLabel(0.72, undefined)).toBe("72%");
  expect(progressLabel(0.72, "")).toBe("72%");
  expect(progressLabel(0.92, "92% used")).toBe("92% used");
  expect(progressLabel(0.92, "93% used")).toBe("92% 93% used");
});

test("a column of numbers lines up on the right", () => {
  expect(isNumeric("1,200")).toBe(true);
  expect(isNumeric("-3.5")).toBe(true);
  expect(isNumeric("42%")).toBe(true);
  // A number with a short unit lines up too: sizes, durations.
  expect(isNumeric("210 GB")).toBe(true);
  expect(isNumeric("abc")).toBe(false);
  expect(isNumeric("v2 beta")).toBe(false);
  expect(isNumeric("")).toBe(false);
  expect(isNumeric(node("Tag", { label: "1" }))).toBe(false);
  const body = [
    ["Acme", "1200"],
    ["Globex", "480"],
  ];
  expect(numericColumns(2, body)).toEqual([false, true]);
  expect(numericColumns(1, [])).toEqual([false]);
});

test("table columns share the width by their longest cell, kept between a least and a most", () => {
  const body = [
    ["Acme", node("Tag", { label: "Professional" }), "1200"],
    ["Globex Corporation of the North", "Team", "480"],
  ];
  const weights = tableWeights(["Account", "Plan", "MRR"], body);
  expect(weights).toHaveLength(3);
  expect(weights[0]).toBeGreaterThan(weights[2] ?? 0);
  expect(weights[1]).toBe("Professional".length);
  expect(Math.max(...tableWeights(["x"], [["y".repeat(300)]]))).toBe(40);
  expect(Math.min(...tableWeights(["x"], [["y"]]))).toBe(5);
  expect(tableWeights(["a", "b"], [[]])).toHaveLength(2);
});

test("list markers are bullets or numbers", () => {
  expect(marker(false, 3)).toBe("•");
  expect(marker(true, 0)).toBe("1.");
});

test("props are read for what they are and anything else is nothing", () => {
  const n = node("Thing", {
    text: "hi",
    count: 3,
    nan: Number.NaN,
    flag: true,
    kids: [node("A"), "x", null, node("B")],
    tone: "danger",
    values: [1, "2", null, 4],
    words: ["a", 2, true, null],
  });
  expect(str(n, "text")).toBe("hi");
  expect(str(n, "count")).toBe("3");
  expect(str(n, "nan")).toBeUndefined();
  expect(str(n, "flag")).toBeUndefined();
  expect(nodes(n, "kids").map((k) => k.component)).toEqual(["A", "B"]);
  expect(nodes(n, "missing")).toEqual([]);
  expect(tone(n)).toBe("danger");
  expect(tone(node("T", { tone: "pink" }))).toBeUndefined();
  expect(numbers(n, "values")).toEqual([1, 0, 0, 4]);
  expect(strings(n, "words")).toEqual(["a", "2", "true", ""]);
  expect(isNode({ component: "X" })).toBe(true);
  expect(isNode({ props: {} })).toBe(false);
  expect(isNode(null)).toBe(false);
});

test("table cells are text or nodes, and a node cell has the text it shows", () => {
  const table = node("Table", {
    rows: [["a", 1, true, node("Tag", { label: "t" })], "oops", [null]],
  });
  const body = rows(table);
  expect(body).toHaveLength(3);
  expect(body[0]?.slice(0, 3)).toEqual(["a", "1", "true"]);
  expect(body[1]).toEqual([]);
  expect(body[2]).toEqual([""]);
  const cell = body[0]?.[3];
  expect(cell !== undefined && cellText(cell)).toBe("t");
  expect(cellText(node("Link", { text: "docs", url: "https://x" }))).toBe("docs");
  expect(cellText(node("Link", { url: "https://x" }))).toBe("https://x");
  expect(cellText(node("MetricIndicator", { value: "12", delta: "3%" }))).toBe("12 3%");
  expect(cellText(node("Card"))).toBe("");
});

test("options and group items have a value, a label and a description", () => {
  const select = node("Select", {
    options: [node("Option", { value: "a" }), node("Option", { value: "b", label: "Bee" })],
  });
  expect(choices(select)).toEqual([
    { value: "a", label: "a", description: undefined },
    { value: "b", label: "Bee", description: undefined },
  ]);
  const cards = node("OptionCards", {
    options: [node("OptionCard", { value: "p", title: "Pro", description: "For teams" })],
  });
  expect(choices(cards)).toEqual([{ value: "p", label: "Pro", description: "For teams" }]);
  const group = node("CheckBoxGroup", {
    items: [node("CheckBoxItem", { name: "ci", label: "CI", description: "Faster" })],
  });
  expect(groupItems(group)).toEqual([{ name: "ci", label: "CI", description: "Faster" }]);
});
