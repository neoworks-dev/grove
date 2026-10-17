// The documents the Rust host keeps, reached through svelte-gpui's `invoke` and `listen`. The
// commands and events are the ones `src/editor/documents.rs` registers. Kept apart from the
// service so the service runs under `bun test` without the host.

import { invoke, listen } from "@neoworks/svelte-gpui";
import type { DocumentEvent, DocumentHost, DocumentSummary, IndentStyle } from "./service";

/** Documents kept by the native host, which the editor element shows by id. */
export function gpuiDocumentHost(): DocumentHost {
  return {
    open: (path) => invoke<DocumentSummary>("document_open", { path }),
    close: async (id) => {
      await invoke("document_close", { id });
    },
    save: async (id) => {
      await invoke("document_save", { id });
    },
    setDecorations: async (id, source, decorations) => {
      await invoke("document_set_decorations", { id, source, decorations });
    },
    configure: async (options) => {
      await invoke("editor_configure", options);
    },
    openText: (name, text) => invoke<DocumentSummary>("document_open_text", { name, text }),
    text: (id) => invoke<string>("document_text", { id }),
    setText: async (id, text) => {
      await invoke("document_set_text", { id, text });
    },
    reload: async (id) => {
      await invoke("document_reload", { id });
    },
    onEvent: listenToDocuments,
  };
}

/** Passes the host's `document-*` events on as `DocumentEvent`s, and returns the function that stops. */
function listenToDocuments(handler: (event: DocumentEvent) => void): () => void {
  const stops = [
    listen<DocumentSummary>("document-opened", (summary) => handler({ type: "opened", summary })),
    listen<{ id: number }>("document-closed", (event) => handler({ type: "closed", id: event.id })),
    listen<{ id: number; dirty: boolean }>("document-dirty", (event) => handler({ type: "dirty", ...event })),
    listen<{ id: number }>("document-saved", (event) => handler({ type: "saved", id: event.id })),
    listen<{ id: number }>("document-edited", (event) => handler({ type: "edited", id: event.id })),
    listen<{ id: number; message: string }>("document-error", (event) => handler({ type: "error", ...event })),
    listen<{ id: number; row: number; column: number; count: number; selected: boolean }>(
      "document-selections",
      (event) => handler({ type: "selections", ...event }),
    ),
    listen<{ id: number; indent: IndentStyle }>("document-indent", (event) => handler({ type: "indent", ...event })),
    listen<{ mode: string; pending: string; commandLine: string | null }>("editor-mode", (event) =>
      handler({ type: "mode", ...event }),
    ),
    listen<{ id: number; request: "close" | "open" | "change"; discard?: boolean; path?: string; forward?: boolean }>(
      "document-request",
      (event) => {
        if (event.request === "close") {
          handler({ type: "close-request", id: event.id, discard: event.discard === true });
          return;
        }
        if (event.request === "change") {
          handler({ type: "change-request", id: event.id, forward: event.forward === true });
          return;
        }
        handler({ type: "open-request", id: event.id, path: event.path ?? "" });
      },
    ),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
