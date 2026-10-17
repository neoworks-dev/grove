// The host's language servers, reached through svelte-gpui's `invoke` and `listen`. The command
// and event are the ones `src/lsp/mod.rs` registers. Kept apart from the service so the service
// runs under `bun test` with a fake.

import { invoke, listen } from "@neoworks/svelte-gpui";
import type { ServerSummary } from "./servers";

/** What the service needs from the host's language servers. */
export interface LspHost {
  /** The servers now. */
  status(): Promise<ServerSummary[]>;
  /** Starts a server again. */
  restart(id: number): Promise<void>;
  /** Hears the list of servers whenever one changes. Returns the function that stops it. */
  onStatus(handler: (servers: ServerSummary[]) => void): () => void;
  /** Tells the host which language features the person has switched on. */
  configure(options: LspOptions): Promise<void>;
  /** Tells the host that files changed on disk, so servers that asked to hear of it do. */
  filesChanged(changes: FileChange[]): Promise<void>;
}

/** The switches of the language features, as the settings have them. */
export interface LspOptions {
  inlayHints: boolean;
  formatOnSave: boolean;
  eslint: boolean;
}

/** A change to a file, with its absolute path. */
export interface FileChange {
  path: string;
  kind: "created" | "changed" | "deleted";
}

/** The language servers of the native host. */
export function gpuiLspHost(): LspHost {
  return {
    status: () => invoke<ServerSummary[]>("lsp_status"),
    restart: async (id) => {
      await invoke("lsp_restart", { id });
    },
    onStatus: (handler) => listen<ServerSummary[]>("lsp-status", handler),
    configure: async (options) => {
      await invoke("lsp_configure", { ...options });
    },
    filesChanged: async (changes) => {
      await invoke("lsp_files_changed", { changes });
    },
  };
}
