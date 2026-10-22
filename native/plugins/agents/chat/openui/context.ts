// How the parts of a doc reach the doc they are drawn in: its visual state (the selected tab, the
// open accordion items).
import { getContext, setContext } from "svelte";
import type { DocView } from "./state.svelte";

const KEY = Symbol("neoui doc");

/** What the nodes of a doc reach through `useDoc`. */
export interface Doc {
  /** The doc's visual state. Read through the doc, which follows the item it is drawn for. */
  readonly view: DocView;
}

/** Makes a doc reachable from every node drawn below the caller. */
export function provideDoc(doc: Doc): void {
  setContext(KEY, doc);
}

/** The doc the component is drawn in (call it while initialising). */
export function useDoc(): Doc {
  const doc = getContext<Doc | undefined>(KEY);
  if (!doc) throw new Error("useDoc: this component was not drawn inside a neoui doc");
  return doc;
}
