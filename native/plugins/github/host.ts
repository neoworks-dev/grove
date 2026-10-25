// The GitHub CLI runs of the Rust host, reached through svelte-gpui's `invoke`. Kept apart from
// the client so the client runs under `bun test` without the host.

import { invoke } from "@neoworks/svelte-gpui";
import type { GhAnswer, GhRunner } from "./client";

/** Asks the host to run `gh`, as `src/gh.rs` describes. */
export const runOnHost: GhRunner = (request) => invoke<GhAnswer>("gh_run", request);

/** Opens an address in the system's browser through the host, as the chat's links do. */
export function openUrlOnHost(url: string): void {
  void invoke("open_url", { url });
}
