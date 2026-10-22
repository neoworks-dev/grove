// How the parts of a doc reach the doc: its session (values, what is sent, the visual state).
import { getContext, setContext } from "svelte";
import type { DocSession } from "./session";
import type { DocView } from "./state.svelte";

const KEY = Symbol("neoui doc");

/** Makes a doc's session reachable from every node drawn below the caller. */
export function provideDoc(session: DocSession<DocView>): void {
  setContext(KEY, session);
}

/** The doc the component is drawn in (call it while initialising). */
export function useDoc(): DocSession<DocView> {
  const session = getContext<DocSession<DocView> | undefined>(KEY);
  if (!session) throw new Error("useDoc: this component was not drawn inside a neoui doc");
  return session;
}
