// What the split layout needs from whoever owns the layout tree. The tree itself and the
// operations on it live in `layoutTree.ts`; this is the seam where an app's store (the kernel's
// layout service, or a test double) answers the questions only it can: how big a pane must stay,
// whether it holds a fixed size, and what a drag changes.

import type { LayoutNode, SplitDirection } from "./layoutTree";

export interface LayoutHost {
  /** The pixels a pane holds along its parent's axis, or null when it takes a share instead. */
  fixedSizePx(node: LayoutNode): number | null;
  /** The least a node may shrink to along `direction`, in pixels. */
  minSizePx(node: LayoutNode, direction: SplitDirection): number;
  /** Moves the boundary between two children of a split by a fraction of the split. */
  resize(splitId: string, gutterIndex: number, deltaFraction: number, minBefore: number, minAfter: number): void;
  /** Gives a pane a size of its own, in pixels. */
  setFixedSizePx(leafId: string, px: number): void;
  /** Hands a fixed pane the size it was first drawn at, when it has none yet. */
  adoptFixedSizePx?(leafId: string, px: number): void;
  closeLeaf(leafId: string): void;
  /** The pane a drag has squeezed past its collapse point, hidden until the drag ends. */
  collapsingLeafId: string | null;
  /** Called by a gutter's "+" button; leave it out and the button is not drawn. */
  addPaneAtGutter?(splitId: string, gutterIndex: number): void;
}
