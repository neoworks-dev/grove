// The terminals the Rust host keeps, reached through svelte-gpui's `invoke` and `listen`. The commands
// and events are the ones `src/terminal/mod.rs` registers. Kept apart from the service so the service
// runs under `bun test` without the host.

import { invoke, listen } from "@neoworks/svelte-gpui";
import type { TerminalEvent, TerminalHost } from "./service";

/** The host's terminals. */
export function gpuiTerminalHost(): TerminalHost {
  return {
    kill: async (id) => {
      await invoke("terminal_kill", { id });
    },
    workingDirectory: (id) => invoke<string | null>("terminal_cwd", { id }),
    onEvent: listenToTerminals,
  };
}

/** Passes the host's `terminal-*` events on as `TerminalEvent`s, and returns the function that stops. */
function listenToTerminals(handler: (event: TerminalEvent) => void): () => void {
  const stops = [
    listen<{ id: string; title: string }>("terminal-title", (event) =>
      handler({ type: "title", id: event.id, title: event.title }),
    ),
    listen<{ id: string }>("terminal-bell", (event) => handler({ type: "bell", id: event.id })),
    listen<{ id: string; code: number | null }>("terminal-exit", (event) =>
      handler({ type: "exit", id: event.id, code: event.code }),
    ),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
