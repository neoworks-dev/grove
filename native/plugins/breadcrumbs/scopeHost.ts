// What breadcrumbs ask the native host: the scopes around a place in a document
// (`document_scopes`, see `src/editor/documents.rs`). Kept apart from the service so the service
// runs under `bun test` with a fake.

import { invoke } from "@neoworks/svelte-gpui";
import type { Scope } from "./model";

/** The question about a document that the syntax tree answers. */
export interface ScopeHost {
  /** The scopes enclosing a row and column of a document, outermost first. */
  scopesAt(documentId: number, row: number, column: number): Promise<Scope[]>;
}

/** The scopes as the native host reads them from its syntax trees. */
export function gpuiScopeHost(): ScopeHost {
  return {
    scopesAt: (documentId, row, column) => invoke<Scope[]>("document_scopes", { id: documentId, row, column }),
  };
}
