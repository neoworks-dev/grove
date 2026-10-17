// The `layout` service: the split tree of the main area and the operations on it. The tree is
// Grove's, from `layoutTree.ts`; this class owns the current root and the focused pane, and
// answers the questions the split components ask their host (`LayoutHost`). A leaf names a pane
// type, which is the key of an entry in the frame's `main` slot, so any plugin that registers
// into `main` can be shown in a pane. State is plain fields with a change signal, never `$state`.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { LayoutHost } from "./host";
import {
  createLeaf,
  findLeaf,
  leaves,
  moveLeaf,
  removeLeaf,
  resizeGutter,
  splitLeaf,
  type DropZone,
  type LayoutNode,
  type SplitDirection,
} from "./layoutTree";

declare module "@neoworks/extension-system" {
  interface Context {
    layout: LayoutService;
  }
}

/** No pane may be squeezed under a readable width. */
const MIN_PANE_PX = 120;

export class LayoutService extends Service implements LayoutHost {
  private rootNode: LayoutNode;
  private focusedId: string;
  private collapsingId: string | null = null;
  private newPaneTypeId: string;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, defaultPaneTypeId: string, newPaneTypeId: string) {
    super(ctx, "layout");
    const first = createLeaf(defaultPaneTypeId);
    this.rootNode = first;
    this.focusedId = first.id;
    this.newPaneTypeId = newPaneTypeId;
  }

  /** The tree of panes. Reactive. */
  get root(): LayoutNode {
    this.changes.track();
    return this.rootNode;
  }

  /** The id of the focused pane. Reactive. */
  get focusedLeafId(): string {
    this.changes.track();
    return this.focusedId;
  }

  /** The pane a drag has squeezed past its collapse point, hidden until the drag ends. Reactive. */
  get collapsingLeafId(): string | null {
    this.changes.track();
    return this.collapsingId;
  }

  set collapsingLeafId(leafId: string | null) {
    this.collapsingId = leafId;
    this.changes.notify();
  }

  /** How many panes are open. Reactive. */
  leafCount(): number {
    return leaves(this.root).length;
  }

  /** Splits the focused pane, putting a new pane of the configured type after it, and focuses that. */
  splitFocused(direction: SplitDirection): void {
    const created = createLeaf(this.newPaneTypeId);
    this.rootNode = splitLeaf(this.rootNode, this.focusedId, direction, created, "after");
    this.focusedId = created.id;
    this.changes.notify();
  }

  /** Gives a pane the focus; ids that name no pane are ignored. */
  focus(leafId: string): void {
    if (!findLeaf(this.rootNode, leafId)) {
      return;
    }
    this.focusedId = leafId;
    this.changes.notify();
  }

  /** Moves the focus to the next pane in reading order, wrapping at the end. */
  focusNext(): void {
    const panes = leaves(this.rootNode);
    const index = panes.findIndex((pane) => pane.id === this.focusedId);
    this.focus(panes[(index + 1) % panes.length].id);
  }

  /** Closes the focused pane. */
  closeFocused(): void {
    this.closeLeaf(this.focusedId);
  }

  /** Closes a pane and gives its space to its siblings. The last pane stays: the tree is never empty. */
  closeLeaf(leafId: string): void {
    const remaining = removeLeaf(this.rootNode, leafId);
    this.collapsingId = null;
    if (remaining === null) {
      this.changes.notify();
      return;
    }
    this.rootNode = remaining;
    if (!findLeaf(remaining, this.focusedId)) {
      this.focusedId = leaves(remaining)[0].id;
    }
    this.changes.notify();
  }

  /** A dragged pane was dropped on another: it swaps places in the middle, or splits it at an edge. */
  dropPane(draggedLeafId: string, targetLeafId: string, zone: DropZone): void {
    this.rootNode = moveLeaf(this.rootNode, draggedLeafId, targetLeafId, zone);
    this.focusedId = draggedLeafId;
    this.changes.notify();
  }

  /** Panes here share the window by fractions; none holds a fixed size. */
  fixedSizePx(): number | null {
    return null;
  }

  /** The least a pane may shrink to. */
  minSizePx(): number {
    return MIN_PANE_PX;
  }

  /** Moves the boundary between two children of a split. */
  resize(splitId: string, gutterIndex: number, deltaFraction: number, minBefore: number, minAfter: number): void {
    this.rootNode = resizeGutter(this.rootNode, splitId, gutterIndex, deltaFraction, minBefore, minAfter);
    this.changes.notify();
  }

  /** Panes here never hold pixels, so there is nothing to record. */
  setFixedSizePx(): void {}
}

