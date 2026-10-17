// What the chat shows beyond the items themselves: whether tool results and thoughts are
// shown in full, and which results the user opened by pressing their header. Kept here and
// not in a row, since the list builds rows only near the window and a row's own state is lost
// when it scrolls away. Shared by every chat pane.

import { createChangeSignal, type ChangeSignal } from "../../../kernel/reactive";

export class ChatViewState {
  private expandedResults = false;
  private thoughtsShown = false;
  private openedRefs: ReadonlySet<string> = new Set();
  private changes: ChangeSignal = createChangeSignal();

  /** Whether tool results and cards are shown in full. Reactive. */
  get expanded(): boolean {
    this.changes.track();
    return this.expandedResults;
  }

  /** Whether the agent's thoughts are shown. Reactive. */
  get showThoughts(): boolean {
    this.changes.track();
    return this.thoughtsShown;
  }

  /** Shows or hides tool results in full. */
  toggleExpanded(): void {
    this.expandedResults = !this.expandedResults;
    this.changes.notify();
  }

  /** Shows or hides the agent's thoughts. */
  toggleThoughts(): void {
    this.thoughtsShown = !this.thoughtsShown;
    this.changes.notify();
  }

  /** Whether the user opened the result of the item with this ref. Reactive. */
  isOpened(ref: string): boolean {
    this.changes.track();
    return this.openedRefs.has(ref);
  }

  /** Opens the result of an item, or closes it when it is open. */
  toggleOpened(ref: string): void {
    const next = new Set(this.openedRefs);
    if (!next.delete(ref)) {
      next.add(ref);
    }
    this.openedRefs = next;
    this.changes.notify();
  }

  /** The items to draw: thoughts only while they are shown. */
  visibleItems<Item extends { kind: string }>(items: readonly Item[]): Item[] {
    return items.filter((item) => item.kind !== "thought" || this.showThoughts);
  }
}

/** The one chat view state of the window. */
export const chatView = new ChatViewState();
