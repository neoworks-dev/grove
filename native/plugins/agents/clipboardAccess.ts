// The system clipboard as the composer pastes from it: its text through svelte-gpui, its image
// through the host's `clipboard_image` command (src/clipboard.rs). Kept apart from composerModel.ts,
// which runs without a window.

import { clipboard, files, invoke } from "@neoworks/svelte-gpui";
import type { ClipboardAccess } from "./composerModel";

/** The clipboard of the running app. */
export function createClipboardAccess(): ClipboardAccess {
  return {
    async image() {
      try {
        return await invoke<string | null>("clipboard_image");
      } catch {
        return null;
      }
    },
    async text() {
      try {
        return await clipboard.read();
      } catch {
        return "";
      }
    },
    async exists(path) {
      try {
        return await files.exists(path);
      } catch {
        return false;
      }
    },
  };
}
