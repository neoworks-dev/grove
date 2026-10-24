// The modules an extension's script may `require`. They are the app's own copies: Svelte keeps
// its state in module variables, so a script that carried a second copy of the runtime would
// render into nothing. Kept apart from the kernel because importing svelte-gpui needs the host.

import * as extensionSystem from "@neoworks/extension-system";
import * as gpui from "@neoworks/svelte-gpui";
import * as gpuiUi from "@neoworks/svelte-gpui/ui";
import * as svelte from "svelte";
import * as discloseVersion from "svelte/internal/disclose-version";
import * as svelteClient from "svelte/internal/client";
import type { SharedModules } from "../kernel/extensions";
import { defineSettings, setting } from "../kernel/settings";
import { colors, fontSize, radius, size, space } from "../plugins/theme/tokens";

/** What `@grove/extension` offers beside `definePlugin`, which the evaluator adds. */
const groveApi = { defineSettings, setting, colors, fontSize, radius, size, space };

/** Every module an extension script can ask for, by the name it imports. */
export const extensionModules: SharedModules = {
  svelte,
  "svelte/internal/client": svelteClient,
  "svelte/internal/disclose-version": discloseVersion,
  "@neoworks/svelte-gpui": gpui,
  "@neoworks/svelte-gpui/ui": gpuiUi,
  "@neoworks/extension-system": extensionSystem,
  "@grove/extension": groveApi,
};
