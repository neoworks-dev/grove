// The ripgrep runs of the Rust host, reached through svelte-gpui's `invoke`. Kept apart from the
// service so the service runs under `bun test` without the host.

import { invoke } from "@neoworks/svelte-gpui";
import type { RipgrepAnswer, RipgrepRunner } from "./service";

/** Asks the host to run ripgrep, as `src/ripgrep.rs` describes. */
export const runOnHost: RipgrepRunner = (request) => invoke<RipgrepAnswer>("ripgrep_run", request);
