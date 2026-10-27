// The host's `syntax_highlight` command, and the one highlighter the chat's components share. Kept
// apart from highlight.ts, which runs without a window.

import { invoke } from "@neoworks/svelte-gpui";
import { Highlighter, type HostHighlight } from "./highlight";

/** The chat's highlighter, over the running app's host. */
export const chatHighlighter = new Highlighter((text, path) => invoke<HostHighlight>("syntax_highlight", { text, path }));
