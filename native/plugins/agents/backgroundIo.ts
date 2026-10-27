// What following background commands touches outside the pane: their output files, and the host's
// `background_stop` command (src/background.rs). Kept apart from background.ts, which runs without
// a window.

import { files, invoke } from "@neoworks/svelte-gpui";
import type { BackgroundIo } from "./background";

/** The background commands' io in the running app. */
export function createBackgroundIo(): BackgroundIo {
  return {
    async readOutput(path) {
      try {
        return await files.readText(path);
      } catch {
        return undefined;
      }
    },
    async stop(path) {
      try {
        await invoke("background_stop", { path });
      } catch (error) {
        throw new Error(`could not stop the command: ${String(error)}`);
      }
    },
  };
}
