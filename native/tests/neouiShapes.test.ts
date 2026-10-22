import { expect, test } from "bun:test";
import type { UiNode } from "@suite/protocol/types";
import {
  askOf,
  GRID_MIN,
  minWidthOf,
  segments,
  shareWidth,
} from "../plugins/agents/chat/openui/layout";
import { aspectOf, canvasHeight, shapeSvg } from "../plugins/agents/chat/openui/shapes";

const node = (component: string, props: Record<string, unknown> = {}): UiNode => ({
  component,
  props,
});
const shape = (kind: string, points: number[], extra: Record<string, unknown> = {}): UiNode =>
  node("Shape", { kind, points, ...extra });
const box = (extra: Record<string, unknown> = {}): UiNode =>
  node("Box", { children: [], ...extra });

test("a Box asks its parent for fill, fit or a share of its width; anything else asks for nothing", () => {
  expect(askOf(box({ width: "fill" }))).toBe("fill");
  expect(askOf(box({ width: "fit" }))).toBe("fit");
  expect(askOf(box({ width: 0.3 }))).toBe(0.3);
  expect(askOf(box({ width: 3 }))).toBe(1);
  expect(askOf(box({ width: 0 }))).toBeUndefined();
  expect(askOf(box({ width: -1 }))).toBeUndefined();
  expect(askOf(box({ width: "wide" }))).toBeUndefined();
  expect(askOf(box())).toBeUndefined();
  expect(askOf(node("Stack", { width: 0.5 }))).toBeUndefined();
});

test("a share is of the room there is, at least a pixel and never more than the room", () => {
  expect(shareWidth(0.25, 400)).toBe(100);
  expect(shareWidth(1, 400)).toBe(400);
  expect(shareWidth(0.001, 400)).toBe(1);
  expect(shareWidth(0.5, 0)).toBe(0);
});

test("a Box that shares or fills may shrink to a sliver of a row, one that fits needs its content", () => {
  expect(minWidthOf(box({ width: 0.25 }))).toBeLessThan(GRID_MIN - 40);
  expect(minWidthOf(box({ width: "fill" }))).toBeLessThan(GRID_MIN - 40);
  expect(minWidthOf(box())).toBe(GRID_MIN - 40);
  expect(minWidthOf(box({ width: "fit" }))).toBe(GRID_MIN - 40);
});

test("a run of two or more Shapes is one canvas, a lone one stays itself", () => {
  const text = node("Text");
  const parts = segments([
    shape("rect", [0, 0, 1, 1]),
    shape("line", [0, 0, 1, 1]),
    text,
    shape("arc", []),
  ]);
  expect(parts.map((part) => part.kind)).toEqual(["shapes", "node", "node"]);
  const run = parts[0];
  expect(run?.kind === "shapes" && run.items.map((at) => at.index)).toEqual([0, 1]);
});

test("the box is as tall as the first shape's aspect says, held between a sliver and a screen", () => {
  expect(aspectOf(shape("rect", []))).toBe(2);
  expect(aspectOf(shape("rect", [], { aspect: 4 }))).toBe(4);
  expect(aspectOf(shape("rect", [], { aspect: -4 }))).toBe(2);
  expect(canvasHeight(400, [shape("rect", [])])).toBe(200);
  expect(
    canvasHeight(400, [shape("rect", [], { aspect: 16 }), shape("rect", [], { aspect: 1 })]),
  ).toBe(25);
  expect(canvasHeight(400, [shape("rect", [], { aspect: 1000 })])).toBe(4);
  expect(canvasHeight(400, [shape("rect", [], { aspect: 0.01 })])).toBe(480);
  expect(canvasHeight(400, [])).toBe(200);
});

test("a filled rect is the share of the box it covers, an outline sits inside it", () => {
  expect(shapeSvg(shape("rect", [0.25, 0, 0.5, 1], { fill: true }), 200, 100)).toContain(
    '<rect x="50" y="0" width="100" height="100" fill="#000"',
  );
  const outline = shapeSvg(shape("rect", [0, 0, 1, 1]), 200, 100);
  expect(outline).toContain('<rect x="1" y="1" width="198" height="98" fill="none" stroke="#000"');
  // Points outside the box are held to its edge.
  expect(shapeSvg(shape("rect", [-1, 0, 5, 1], { fill: true }), 200, 100)).toContain(
    'x="0" y="0" width="200" height="100"',
  );
});

test("a line goes through its points, a path closes and a single point is a dot", () => {
  expect(shapeSvg(shape("line", [0, 0, 0.5, 1, 1, 0]), 100, 50)).toContain(
    'd="M0 0 L50 50 L100 0"',
  );
  expect(shapeSvg(shape("path", [0.5, 0, 1, 1, 0, 1], { fill: true }), 100, 100)).toContain(
    'd="M50 0 L100 100 L0 100 Z" fill="#000"',
  );
  expect(shapeSvg(shape("line", [0.5, 0.5]), 100, 100)).toContain("M50 50 L50.01 50");
});

test("an arc is a share of the shorter side, turns clockwise from the top; filled it is a wedge", () => {
  // A quarter turn from the top, in a box twice as wide as tall: the radius is half of 100.
  const quarter = shapeSvg(shape("arc", [0.5, 0.5, 0.5, 0, 0.25]), 200, 100);
  expect(quarter).toContain('d="M100 0 A50 50 0 0 1 150 50"');
  expect(shapeSvg(shape("arc", [0.5, 0.5, 0.5, 0, 0.25], { fill: true }), 200, 100)).toContain(
    'A50 50 0 0 1 150 50 L100 50 Z"',
  );
  // More than half the way round takes the long way, and a whole circle is almost one.
  expect(shapeSvg(shape("arc", [0.5, 0.5, 0.5, 0, 0.75]), 100, 100)).toContain("A50 50 0 1 1");
  expect(shapeSvg(shape("arc", [0.5, 0.5, 0.5, 0, 1]), 100, 100)).toContain("A50 50 0 1 1");
  // From the left to the top through the top is the long way round the other side: a quarter.
  expect(shapeSvg(shape("arc", [0.5, 0.5, 0.5, 0.75, 0.25]), 100, 100)).toContain("A50 50 0 0 1");
});

test("what is not a shape draws an empty box", () => {
  const empty = shapeSvg(shape("blob", [0, 0, 1, 1]), 100, 50);
  expect(empty).toBe(shapeSvg(shape("rect", [0, 0]), 100, 50));
  expect(empty).toContain('width="100" height="50"');
  expect(empty).not.toContain("<path");
  expect(empty).not.toContain("<rect");
});
