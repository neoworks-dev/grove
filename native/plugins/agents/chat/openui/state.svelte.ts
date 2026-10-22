// The visual state of neoui docs (the selected tab, an open accordion item, the slide a carousel
// starts at), kept for the window's lifetime: the chat's list builds a row anew each time it
// scrolls into view, and the state must outlive that. The daemon holds the rest (docs/neoui.md):
// a doc here only draws.

/** What one doc remembers. */
export class DocView {
  tabs = $state<Record<string, number>>({});
  open = $state<Record<string, boolean>>({});
  slides = $state<Record<string, number>>({});

  /** The selected tab of the strip at `path`. */
  tab(path: string): number {
    return this.tabs[path] ?? 0;
  }

  /** Whether the accordion item at `path` is open; `starts` is what the program asked for. */
  isOpen(path: string, starts: boolean): boolean {
    return this.open[path] ?? starts;
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
