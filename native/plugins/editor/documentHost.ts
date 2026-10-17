// The documents the Rust host keeps, reached through svelte-gpui's `invoke` and `listen`. The
// commands and events are the ones `src/editor/documents.rs` registers. Kept apart from the
// service so the service runs under `bun test` without the host.

import { invoke, listen } from "@neoworks/svelte-gpui";
import type { DocumentEvent, DocumentHost, DocumentSummary } from "./service";

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
    listen<{ id: number; message: string }>("document-error", (event) => handler({ type: "error", ...event })),
    listen<{ id: number; row: number; column: number; count: number; selected: boolean }>(
      "document-selections",
      (event) => handler({ type: "selections", ...event }),
    ),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
