// The layout store the temporary gallery in App.svelte uses: a tree and the operations the
// split components ask of their host. The kernel's layout service replaces it.

import type { LayoutHost } from "../plugins/layout/host";
import {
  createLeaf,
  createSplit,
  moveLeaf,
  removeLeaf,
  resizeGutter,
  type DropZone,
  type LayoutNode,
  type LeafNode,
  type SplitDirection,
} from "../plugins/layout/layoutTree";

const SIDEBAR_WIDTH_PX = 240;
const MIN_PANE_PX = 120;

export class DemoLayout implements LayoutHost {
  readonly sidebar: LeafNode = createLeaf("sidebar");
  readonly editor: LeafNode = createLeaf("editor");
  readonly notes: LeafNode = createLeaf("notes");

  root = $state<LayoutNode>(createSplit("row", [this.sidebar, this.editor, this.notes], [0.2, 0.5, 0.3]));
  collapsingLeafId = $state<string | null>(null);
  fixedSizes = $state<Record<string, number>>({ [this.sidebar.id]: SIDEBAR_WIDTH_PX });
  focusedLeafId = $state(this.editor.id);

  /** The sidebar holds its pixels; the other panes share what is left. */
  fixedSizePx(node: LayoutNode): number | null {
    const px = this.fixedSizes[node.id];
    if (px === undefined) {
      return null;
    }
    return px;
  }

  /** No pane may be squeezed under a readable width. */
  minSizePx(_node: LayoutNode, _direction: SplitDirection): number {
    return MIN_PANE_PX;
  }

  resize(splitId: string, gutterIndex: number, deltaFraction: number, minBefore: number, minAfter: number): void {
    this.root = resizeGutter(this.root, splitId, gutterIndex, deltaFraction, minBefore, minAfter);
  }

  setFixedSizePx(leafId: string, px: number): void {
    this.fixedSizes[leafId] = px;
  }

  closeLeaf(leafId: string): void {
    const remaining = removeLeaf(this.root, leafId);
    if (remaining !== null) {
      this.root = remaining;
    }
  }

  /** A dragged pane was dropped on another. */
  dropPane(draggedLeafId: string, targetLeafId: string, zone: DropZone): void {
    this.root = moveLeaf(this.root, draggedLeafId, targetLeafId, zone);
  }
}
