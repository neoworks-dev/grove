import { describe, expect, it } from "bun:test";
import { GutterDrag } from "../plugins/layout/gutterDrag";
import type { LayoutHost } from "../plugins/layout/host";
import { createLeaf, createSplit, resizeGutter, type LayoutNode, type SplitNode } from "../plugins/layout/layoutTree";

/** A host over a tree it updates the way the layout store does. */
function makeHost(root: { node: LayoutNode }, fixed: Record<string, number> = {}) {
  const closed: string[] = [];
  const host: LayoutHost = {
    collapsingLeafId: null,
    fixedSizePx: (node) => fixed[node.id] ?? null,
    minSizePx: () => 100,
    resize: (splitId, gutterIndex, delta, minBefore, minAfter) => {
      root.node = resizeGutter(root.node, splitId, gutterIndex, delta, minBefore, minAfter);
    },
    setFixedSizePx: (leafId, px) => {
      fixed[leafId] = px;
    },
    closeLeaf: (leafId) => closed.push(leafId),
  };
  return { host, closed, fixed };
}

/** Two equal panes, 1000 px between them. */
function makeTwoPanes() {
  const split = createSplit("row", [createLeaf("a"), createLeaf("b")]);
  const root = { node: split as LayoutNode };
  const drag = (host: LayoutHost) => new GutterDrag(() => ({ host, split: root.node as SplitNode, gutterIndex: 0, pairPx: 1000 }));
  return { root, drag };
}

describe("GutterDrag", () => {
  it("turns pointer movement into a shift of the shares", () => {
    const { root, drag } = makeTwoPanes();
    const { host } = makeHost(root);
    const session = drag(host);
    session.start(500);
    session.move(600);
    const sizes = (root.node as SplitNode).sizes;
    expect(sizes[0]).toBeCloseTo(0.6);
    expect(sizes[1]).toBeCloseTo(0.4);
  });

  it("ignores movement before it has started", () => {
    const { root, drag } = makeTwoPanes();
    const { host } = makeHost(root);
    drag(host).move(900);
    expect((root.node as SplitNode).sizes[0]).toBeCloseTo(0.5);
  });

  it("collapses a pane pushed far past its minimum, and closes it on release", () => {
    const { root, drag } = makeTwoPanes();
    const { host, closed } = makeHost(root);
    const session = drag(host);
    session.start(500);
    session.move(1000);
    const squeezed = (root.node as SplitNode).children[1].id;
    expect(host.collapsingLeafId).toBe(squeezed);
    session.end();
    expect(closed).toEqual([squeezed]);
    expect(host.collapsingLeafId).toBeNull();
  });

  it("brings a collapsing pane back when the drag is cancelled", () => {
    const { root, drag } = makeTwoPanes();
    const { host, closed } = makeHost(root);
    const session = drag(host);
    session.start(500);
    session.move(1000);
    session.cancel();
    expect(closed).toEqual([]);
    expect(host.collapsingLeafId).toBeNull();
  });

  it("resizes the pixels of a fixed pane and leaves the shares alone", () => {
    const { root, drag } = makeTwoPanes();
    const firstId = (root.node as SplitNode).children[0].id;
    const { host, fixed } = makeHost(root, { [firstId]: 300 });
    const session = drag(host);
    session.start(300);
    session.move(350);
    expect(fixed[firstId]).toBe(350);
    expect((root.node as SplitNode).sizes[0]).toBeCloseTo(0.5);
  });

  it("moves a step per arrow key", () => {
    const { root, drag } = makeTwoPanes();
    const { host } = makeHost(root);
    drag(host).nudge(1);
    expect((root.node as SplitNode).sizes[0]).toBeCloseTo(0.5 + 24 / 1000);
  });
});
