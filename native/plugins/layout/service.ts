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

/** Called with the new pane and the pane it was split from. */
export type PaneSplitListener = (newLeafId: string, sourceLeafId: string) => void;

/** Called with a pane that was closed. By then the focus is on a pane that is still open. */
export type PaneClosedListener = (leafId: string) => void;

export class LayoutService extends Service implements LayoutHost {
  private rootNode: LayoutNode;
  private focusedId: string;
  private collapsingId: string | null = null;
  private newPaneTypeId: string | null;
  private splitListeners: PaneSplitListener[] = [];
  private closedListeners: PaneClosedListener[] = [];
  private changes: ChangeSignal = createChangeSignal();

  /** `newPaneTypeId` is what a split opens; null opens another pane of the type that was split. */
  constructor(ctx: Context, defaultPaneTypeId: string, newPaneTypeId: string | null) {
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

  /** The ids of every pane, in reading order. Reactive. */
  leafIds(): string[] {
    return leaves(this.root).map((leaf) => leaf.id);
  }

  /** The pane type a pane shows, or undefined for an id that names no pane. Reactive. */
  paneTypeOf(leafId: string): string | undefined {
    return findLeaf(this.root, leafId)?.paneTypeId;
  }

  /** Hears of every split, so a plugin can fill the new pane from the one it came from. */
  onPaneSplit(listener: PaneSplitListener): () => void {
    this.splitListeners.push(listener);
    return () => {
      this.splitListeners = this.splitListeners.filter((candidate) => candidate !== listener);
    };
  }

  /** Hears of every pane that closes, so a plugin can let go of what it kept for it. */
  onPaneClosed(listener: PaneClosedListener): () => void {
    this.closedListeners.push(listener);
    return () => {
      this.closedListeners = this.closedListeners.filter((candidate) => candidate !== listener);
    };
  }

  /**
   * Splits the focused pane and focuses the new one. The new pane is of the configured type, or
   * of the type that was split when none is configured, as a split of an editor is another editor.
   */
  splitFocused(direction: SplitDirection): void {
    const source = findLeaf(this.rootNode, this.focusedId);
    if (!source) {
      return;
    }
    let paneTypeId = source.paneTypeId;
    if (this.newPaneTypeId !== null) {
      paneTypeId = this.newPaneTypeId;
    }
    const created = createLeaf(paneTypeId);
    this.rootNode = splitLeaf(this.rootNode, source.id, direction, created, "after");
    this.focusedId = created.id;
    this.changes.notify();
    for (const listener of this.splitListeners) {
      listener(created.id, source.id);
    }
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
    for (const listener of this.closedListeners) {
      listener(leafId);
    }
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

