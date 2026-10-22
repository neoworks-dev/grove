// The visual state of neoui docs (the selected tab, an open accordion item, the slide a carousel
// starts at, the value just chosen here), kept for the window's lifetime: the chat's list builds
// a row anew each time it scrolls into view, and the state must outlive that. The daemon holds
// the rest (docs/neoui.md): a doc here only draws, and sends what the user does.
import type { UiNode } from "@suite/protocol/types";
import { focusOrder, neighbour } from "./focus";
import { HOLD_MS, same } from "./form";
import type { Held } from "./session";

/** What one doc remembers. */
export class DocView {
  tabs = $state<Record<string, number>>({});
  open = $state<Record<string, boolean>>({});
  slides = $state<Record<string, number>>({});
  /** The item a focused checkbox or switch group has its cursor on. */
  cursors = $state<Record<string, number>>({});
  /** Values chosen here that the daemon has not echoed yet, by field key. */
  held = $state<Record<string, Held>>({});
  /** The id of what has the keyboard (a key or a path), or nothing. */
  focus = $state<string>();
  /** What can be focused now, by id: set while it is drawn. */
  private handles = new Map<string, () => void>();

  /** The selected tab of the strip at `path`. */
  tab(path: string): number {
    return this.tabs[path] ?? 0;
  }

  /** Whether the accordion item at `path` is open; `starts` is what the program asked for. */
  isOpen(path: string, starts: boolean): boolean {
    return this.open[path] ?? starts;
  }

  /** Remembers a value chosen here until the daemon echoes it (or a moment has passed). */
  hold(key: string, value: unknown): void {
    const at = Date.now();
    this.held[key] = { value, at };
    setTimeout(() => {
      if (this.held[key]?.at === at) delete this.held[key];
    }, HOLD_MS);
  }

  /** The daemon sent `value` for a field: a held value it has caught up with is not needed. */
  echoed(key: string, value: unknown): void {
    const held = this.held[key];
    if (held !== undefined && same(held.value, value)) delete this.held[key];
  }

  /** Registers what takes the keyboard under `id`; returns the function that takes it away. */
  register(id: string, take: () => void): () => void {
    this.handles.set(id, take);
    return () => {
      if (this.handles.get(id) === take) this.handles.delete(id);
    };
  }

  /** Gives the keyboard to the id; false when it is not drawn. */
  take(id: string): boolean {
    const take = this.handles.get(id);
    if (take === undefined) return false;
    take();
    return true;
  }

  /** Tab and Shift-Tab: the next thing in drawing order that is drawn. */
  move(root: UiNode | undefined, by: 1 | -1): boolean {
    if (root === undefined) return false;
    const next = neighbour(focusOrder(root, this), this.focus, by, (id) => this.handles.has(id));
    return next !== undefined && this.take(next);
  }
}

const views = new Map<string, DocView>();

/** The state of the doc `id` in chat item `ref` of a session. */
export function viewOf(session: string, ref: string, id: string): DocView {
  const key = JSON.stringify([session, ref, id]);
  let view = views.get(key);
  if (view === undefined) {
    view = new DocView();
    views.set(key, view);
  }
  return view;
}
