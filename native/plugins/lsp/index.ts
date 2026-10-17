// The lsp plugin: the `lsp` service and the language servers' state in the status bar. The
// servers themselves run in the native host (see `src/lsp/mod.rs`).

import type { Context } from "@neoworks/extension-system";
import { gpuiLspHost } from "./host";
import LspStatusItem from "./LspStatusItem.svelte";
import { LspService } from "./service";

export const lsp = {
  name: "lsp",
  inject: ["slots"],
  apply(ctx: Context) {
    const service = new LspService(ctx, gpuiLspHost());
    ctx.slots.register("statusbar", { id: "lsp.status", order: 5, component: LspStatusItem, props: { service, align: "right" } });
  },
};
