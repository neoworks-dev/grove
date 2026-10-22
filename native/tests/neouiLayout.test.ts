import { expect, test } from "bun:test";
import type { UiNode } from "@suite/protocol/types";
import {
  cardsPerRow,
  cellWidth,
  chunk,
  columnsFor,
  entityStacked,
  gapPx,
  GRID_MIN,
  insideCard,
  isInline,
  rowFits,
  segments,
  slideLabel,
  slidesFor,
  slideWindow,
} from "../plugins/agents/chat/openui/layout";

const node = (component: string, props: Record<string, unknown> = {}): UiNode => ({
  component,
  props,
});
const card = (title: string): UiNode => node("Card", { title, children: [] });
const metric = (label: string): UiNode => node("Metric", { label, value: 1 });
const text = (): UiNode => node("Text");

test("a grid has as many columns as fit at the least width, never more than asked for or than it has children", () => {
  expect(columnsFor(700, 6, GRID_MIN, 12)).toBe(2);
  expect(columnsFor(240, 6, GRID_MIN, 12)).toBe(1);
  expect(columnsFor(100, 6, GRID_MIN, 12)).toBe(1);
  expect(columnsFor(1200, 6, GRID_MIN, 12)).toBe(4);
  expect(columnsFor(1200, 6, GRID_MIN, 12, 3)).toBe(3);
  expect(columnsFor(1200, 2, GRID_MIN, 12)).toBe(2);
  expect(columnsFor(1200, 0, GRID_MIN, 12)).toBe(1);
});

test("columns share the width with the gaps taken out, and rows hold that many cells", () => {
  expect(cellWidth(700, 2, 12)).toBe(344);
  expect(cellWidth(700, 1, 12)).toBe(700);
  expect(cellWidth(10, 3, 12)).toBe(0);
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
});

test("a run of two or more sibling cards is a grid and of metrics a strip, others end a run", () => {
  const parts = segments([text(), card("a"), card("b"), card("c"), text(), card("d"), metric("x")]);
  expect(parts.map((part) => part.kind)).toEqual(["node", "cards", "node", "node", "node"]);
  const cards = parts[1];
  expect(cards?.kind === "cards" && cards.items.map((at) => at.index)).toEqual([1, 2, 3]);
  // The lone card and the lone metric stay as they are.
  expect(parts[3]?.kind === "node" && parts[3].at.node.component).toBe("Card");
  expect(parts[4]?.kind === "node" && parts[4].at.index).toBe(6);

  const strip = segments([metric("a"), metric("b"), metric("c")]);
  expect(strip).toHaveLength(1);
  expect(strip[0]?.kind).toBe("metrics");
  // Cards and metrics next to each other are runs of their own.
  expect(segments([card("a"), card("b"), metric("c"), metric("d")]).map((p) => p.kind)).toEqual([
    "cards",
    "metrics",
  ]);
});

test("a row stacks when its children do not fit at their narrowest", () => {
  const tags = [1, 2, 3].map((n) => node("Tag", { label: `tag ${n}` }));
  expect(rowFits(tags, 600, 12)).toBe(true);
  expect(rowFits(tags, 120, 12)).toBe(false);
  expect(rowFits([text()], 10, 12)).toBe(true);
  // Cards need room: two of them do not fit side by side in a narrow column.
  expect(rowFits([card("a"), card("b")], 300, 12)).toBe(false);
  expect(rowFits([card("a"), card("b")], 700, 12)).toBe(true);
});

test("a row lets small things keep their width and has the rest share what is left", () => {
  for (const name of ["Tag", "Button", "Metric", "Text", "Link"])
    expect(isInline(node(name))).toBe(true);
  for (const name of ["Card", "Table", "BarChart", "Form"])
    expect(isInline(node(name))).toBe(false);
  expect(gapPx(undefined)).toBe(12);
  expect(gapPx("none")).toBe(0);
  expect(gapPx("l")).toBeGreaterThan(gapPx("s"));
  expect(insideCard(300)).toBe(270);
});

test("a carousel shows from the first slide in view and the last slide can be the first", () => {
  expect(slideWindow(0, 3, 5)).toEqual({ from: 0, to: 3 });
  expect(slideWindow(3, 3, 5)).toEqual({ from: 3, to: 5 });
  expect(slideWindow(4, 3, 5)).toEqual({ from: 4, to: 5 });
  // A number past the end stays on the last slide.
  expect(slideWindow(9, 3, 5)).toEqual({ from: 4, to: 5 });
  expect(slideWindow(-2, 2, 5)).toEqual({ from: 0, to: 2 });
  expect(slideLabel({ from: 1, to: 2 }, 5)).toBe("2/5");
  expect(slideLabel({ from: 1, to: 3 }, 5)).toBe("2–3/5");
  expect(slidesFor(700, 5, undefined, 12)).toBe(2);
  expect(slidesFor(1200, 5, 3, 12)).toBe(3);
  expect(slidesFor(200, 5, 3, 12)).toBe(1);
});

test("option cards go side by side as far as they fit", () => {
  expect(cardsPerRow(700, 3)).toBe(3);
  expect(cardsPerRow(700, 2)).toBe(2);
  expect(cardsPerRow(300, 3)).toBe(1);
  expect(cardsPerRow(420, 5)).toBe(2);
});

test("an entity list puts each subtitle under its title when the row does not fit", () => {
  const items = [
    { title: "Ada Lovelace", subtitle: "analyst", trailing: "admin" },
    { title: "Grace Hopper", subtitle: "compilers", trailing: "42" },
  ];
  expect(entityStacked(items, 700)).toBe(false);
  expect(entityStacked(items, 260)).toBe(true);
  expect(entityStacked([{ title: "A" }], 120)).toBe(false);
});
