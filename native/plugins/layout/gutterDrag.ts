// One drag of a split gutter: how pointer movement becomes a resize, and when a pane squeezed
// too far collapses. Ported from `SplitGutter.svelte`, which kept all of it in the component;
// here it is plain TypeScript so it can be tested without a window.

import { MIN_PANE_FRACTION, clampGutterShift, type LayoutNode, type SplitNode } from "./layoutTree";
import type { LayoutHost } from "./host";

// Once a neighbour bottoms out at its minimum, dragging this many more pixels past the clamp
// collapses it. Only single leaves collapse; subtrees keep clamping.
const COLLAPSE_SLOP_PX = 40;

// What one arrow key press moves the boundary, in pixels.
export const KEYBOARD_STEP_PX = 24;

/** The gutter being dragged, read afresh on every move as the tree under it changes. */
export interface GutterPlace {
  host: LayoutHost;
  split: SplitNode;
  gutterIndex: number;
  /** Pixels of the two panes the gutter sits between, together. */
  pairPx: number;
}

export class GutterDrag {
  active = false;

  private lastPosition = 0;
  private pxPerFraction = 1;
  // Signed pixels dragged past the size clamp, and the pane they push against.
  private overshoot = 0;
  private overshootNode: LayoutNode | null = null;

  constructor(private readonly place: () => GutterPlace) {}

  /** The host of the gutter as it is now. */
  private get host(): LayoutHost {
    return this.place().host;
  }

  /** Starts a drag at a pointer position along the split's axis. */
  start(position: number): void {
    this.active = true;
    this.setOvershoot(0, null);
    this.lastPosition = position;
    this.measure();
  }

  /** Follows the pointer to a new position along the axis. */
  move(position: number): void {
    if (!this.active) {
      return;
    }
    const delta = position - this.lastPosition;
    this.lastPosition = position;
    this.applyDelta(delta);
  }

  /** Releases the drag: a pane left collapsed is closed. */
  end(): void {
    this.active = false;
    this.commitCollapse();
  }

  /** The drag was taken away: nobody chose to close the pane, so a collapsing one comes back. */
  cancel(): void {
    this.active = false;
    this.setOvershoot(0, null);
  }

  /** Moves the boundary one keyboard step; a pane pushed past its collapse point closes at once. */
  nudge(direction: 1 | -1): void {
    this.measure();
    this.applyDelta(direction * KEYBOARD_STEP_PX);
    if (this.host.collapsingLeafId !== null) {
      this.commitCollapse();
    }
  }

  /** Pixels one unit of share is worth, read off the two panes the gutter sits between. */
  private measure(): void {
    const { split, gutterIndex, pairPx } = this.place();
    const fraction = split.sizes[gutterIndex] + split.sizes[gutterIndex + 1];
    if (pairPx <= 0 || fraction <= 0) {
      return;
    }
    this.pxPerFraction = pairPx / fraction;
  }

  /** The smallest fraction a neighbour may shrink to: its own minimum. */
  private minFractionOf(node: LayoutNode): number {
    const { split } = this.place();
    const minPx = this.host.minSizePx(node, split.direction);
    return Math.max(MIN_PANE_FRACTION, Math.min(0.45, minPx / this.pxPerFraction));
  }

  // A pane that holds a size owns the boundary next to it: the drag changes its pixels and its
  // siblings absorb the difference. Only when neither side holds one do the two shares move.
  private applyDelta(requestedDelta: number): void {
    const delta = this.unwindOvershoot(requestedDelta);
    if (delta === 0) {
      return;
    }
    const { split, gutterIndex } = this.place();
    const before = split.children[gutterIndex];
    const after = split.children[gutterIndex + 1];
    const beforePx = this.host.fixedSizePx(before);
    const afterPx = this.host.fixedSizePx(after);
    if (beforePx === null && afterPx === null) {
      this.resizeShares(delta);
      return;
    }
    if (beforePx !== null) {
      this.resizeFixed(before, beforePx, beforePx + delta);
    }
    if (afterPx !== null) {
      this.resizeFixed(after, afterPx, afterPx - delta);
    }
  }

  /** Spends a drag back toward a squeezed pane on the overshoot first; returns what is left to resize with. */
  private unwindOvershoot(delta: number): number {
    if (this.overshoot === 0 || Math.sign(delta) === Math.sign(this.overshoot)) {
      return delta;
    }
    const unwound = this.overshoot + delta;
    if (Math.sign(unwound) === Math.sign(this.overshoot)) {
      this.setOvershoot(unwound, this.overshootNode);
      return 0;
    }
    this.setOvershoot(0, null);
    return unwound;
  }

  /** Adds drag the clamp could not absorb against `node`; a reversal starts the count over. */
  private addOvershoot(leftoverPx: number, node: LayoutNode): void {
    let total = leftoverPx;
    if (Math.sign(leftoverPx) === Math.sign(this.overshoot)) {
      total += this.overshoot;
    }
    this.setOvershoot(total, node);
  }

  /** Records the overshoot, and hides its pane once it passes the slop. */
  private setOvershoot(amount: number, node: LayoutNode | null): void {
    this.overshoot = amount;
    this.overshootNode = node;
    if (amount === 0) {
      this.overshootNode = null;
    }
    let collapsingLeafId: string | null = null;
    if (this.overshootNode?.kind === "leaf" && Math.abs(this.overshoot) > COLLAPSE_SLOP_PX) {
      collapsingLeafId = this.overshootNode.id;
    }
    this.host.collapsingLeafId = collapsingLeafId;
  }

  /** Commits a fixed pane's new size, stopped at its minimum or at its current size when already under it. */
  private resizeFixed(node: LayoutNode, currentPx: number, requestedPx: number): void {
    const { split } = this.place();
    const floorPx = Math.min(this.host.minSizePx(node, split.direction), currentPx);
    const clamped = Math.max(floorPx, requestedPx);
    this.host.setFixedSizePx(node.id, clamped);
    const leftover = requestedPx - clamped;
    if (leftover === 0) {
      this.setOvershoot(0, null);
      return;
    }
    this.addOvershoot(leftover, node);
  }

  /** Moves the boundary between two panes that share the container. */
  private resizeShares(delta: number): void {
    const { split, gutterIndex } = this.place();
    const before = split.children[gutterIndex];
    const after = split.children[gutterIndex + 1];
    const beforeFraction = split.sizes[gutterIndex];
    const afterFraction = split.sizes[gutterIndex + 1];
    const minBefore = this.minFractionOf(before);
    const minAfter = this.minFractionOf(after);
    const requested = delta / this.pxPerFraction;
    const clamped = clampGutterShift(requested, beforeFraction, afterFraction, minBefore, minAfter);
    const leftoverPx = (requested - clamped) * this.pxPerFraction;
    this.recordLeftover(leftoverPx, before, after);
    if (clamped !== 0) {
      this.host.resize(split.id, gutterIndex, clamped, minBefore, minAfter);
    }
  }

  /** Leftover above zero squeezes the right child, below zero the left one. */
  private recordLeftover(leftoverPx: number, before: LayoutNode, after: LayoutNode): void {
    if (leftoverPx === 0) {
      this.setOvershoot(0, null);
      return;
    }
    if (leftoverPx > 0) {
      this.addOvershoot(leftoverPx, after);
      return;
    }
    this.addOvershoot(leftoverPx, before);
  }

  /** Closes the pane the drag left collapsed, if any, and clears the overshoot. */
  private commitCollapse(): void {
    const leafId = this.host.collapsingLeafId;
    this.setOvershoot(0, null);
    if (leafId !== null) {
      this.host.closeLeaf(leafId);
    }
  }
}
