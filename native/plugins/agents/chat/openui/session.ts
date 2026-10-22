// One doc as its parts reach it: the daemon's values, what was chosen here, what is sent. Plain
// TypeScript over a view that holds the visual state (state.svelte.ts), so it can be tested without
// a window.
import type { UiDoc, UiNode } from "@suite/protocol/types";
import { firstButton } from "./focus";
import { DEBOUNCE_MS, outbox, type Send } from "./form";

/** A value chosen here that the daemon has not echoed yet. */
export interface Held {
  value: unknown;
  at: number;
}

/** What a session needs of the doc's visual state. */
export interface HeldView {
  held: Record<string, Held>;
  hold(key: string, value: unknown): void;
}

/** What a doc needs of the window around it. */
export interface Host<V extends HeldView> {
  ref: string;
  ui: UiDoc;
  view: V;
  send: Send;
  /** Opens an address in the system's browser (or says it can't). */
  open: (url: string) => void;
  copy: (text: string) => void;
}

/** One doc as its parts reach it: the daemon's values, what was chosen here, what is sent. */
export class DocSession<V extends HeldView = HeldView> {
  constructor(private host: () => Host<V>) {}

  get ref(): string {
    return this.host().ref;
  }
  get doc(): string {
    return this.host().ui.id;
  }
  get view(): V {
    return this.host().view;
  }
  /** The doc's root, for moving between its fields. */
  get rootNode(): UiNode | undefined {
    return this.host().ui.root;
  }
  /** Still arriving: it draws, but no field or button can be used. */
  get streaming(): boolean {
    return this.host().ui.streaming === true;
  }

  /** The value of a field now: what was chosen here, else the daemon's. */
  value(node: UiNode): unknown {
    const key = node.key;
    const held = key === undefined ? undefined : this.view.held[key];
    return held === undefined ? node.props["value"] : held.value;
  }

  /**
   * A field's new value. It goes at once, or after a pause with `soon` (typing, a slider being
   * dragged). Until the daemon echoes it the value shows as chosen, unless `hold` is false: a text
   * field keeps its own text while it has focus.
   */
  input(node: UiNode, value: unknown, options: { soon?: boolean; hold?: boolean } = {}): void {
    const key = node.key;
    if (key === undefined || this.streaming) return;
    if (options.hold !== false) this.view.hold(key, value);
    const delay = options.soon === true ? DEBOUNCE_MS : 0;
    outbox.queue(this.ref, { doc: this.doc, key, value }, delay, this.host().send);
  }

  /** The button Enter presses in a field: the form's first, else the doc's first one that can be pressed. */
  firstButton(form?: UiNode): UiNode | undefined {
    return firstButton(form ?? this.host().ui.root);
  }

  /** Opens an address (a link). */
  open(url: string): void {
    this.host().open(url);
  }

  /** What waits for a field goes out now (it lost the keyboard). */
  flush(node: UiNode): void {
    if (node.key !== undefined) outbox.flush(this.ref, this.doc, node.key);
  }

  /** Presses a button: the form's values first, then the press; an address is opened, text copied. */
  press(node: UiNode): void {
    if (this.streaming || node.props["disabled"] === true) return;
    const url = node.props["url"];
    const copy = node.props["copy"];
    if (typeof url === "string") this.host().open(url);
    else if (typeof copy === "string") this.host().copy(copy);
    else if (node.key !== undefined) outbox.press(this.ref, this.doc, node.key, this.host().send);
  }
}
