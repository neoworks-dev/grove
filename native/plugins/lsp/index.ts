// The lsp plugin: the `lsp` service, the language servers' state in the status bar, the switches
// for the language features, and the file changes servers ask to hear about. The servers
// themselves run in the native host (see `src/lsp/mod.rs`).

import type { Context } from "@neoworks/extension-system";
import { defineSettings, setting } from "../../kernel/settings";
import type { LspOptions } from "./host";
import { gpuiLspHost } from "./host";
import LspStatusItem from "./LspStatusItem.svelte";
import { LspService, type WatchedChange } from "./service";

export const lspSettings = defineSettings({
  inlayHints: setting.boolean({
    label: "Inline hints",
    description: "Show parameter names and inferred types inside the code, as the language server gives them.",
    default: true,
    live: true,
  }),
  formatOnSave: setting.boolean({
    label: "Format on save",
    description: "Format a file before it is written: with Prettier where the project has a Prettier config, else with its language server.",
    default: true,
    live: true,
  }),
  eslint: setting.boolean({
    label: "Lint with ESLint",
    description: "Show ESLint's findings in the JavaScript and TypeScript files of projects that have an ESLint config.",
    default: true,
    live: true,
  }),
});

export const lsp = {
  name: "lsp",
  Config: lspSettings,
  inject: ["slots", "settings", "sidecar", "workspace"],
  apply(ctx: Context, config: LspOptions) {
    const service = new LspService(ctx, gpuiLspHost());
    const configure = (options: LspOptions) => {
      service.configure(options).catch((error) => ctx.logger.warn(`lsp: could not apply the settings: ${String(error)}`));
    };
    configure(config);
    ctx.settings.onLive((change) => configure(change.config as unknown as LspOptions));
    ctx.slots.register("statusbar", { id: "lsp.status", order: 5, component: LspStatusItem, props: { service, align: "right" } });
    ctx.sidecar.on("event:fs-change", (payload) => {
      const root = ctx.workspace.selectedWorktree()?.path;
      if (root !== undefined) {
        service.noteWatchedChange(root, payload as unknown as WatchedChange);
      }
    });
  },
};
