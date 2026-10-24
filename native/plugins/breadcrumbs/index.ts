// The breadcrumbs plugin: the `breadcrumbs` service, and the focused editor's path and scopes in
// the status bar, after its file. It is its own plugin so a profile row can switch it off.

import type { Context } from "@neoworks/extension-system";
import Breadcrumbs from "./Breadcrumbs.svelte";
import { gpuiScopeHost } from "./scopeHost";
import { BreadcrumbsService } from "./service";

export const breadcrumbs = {
  name: "breadcrumbs",
  inject: ["slots", "commands", "editor", "workspace", "layout"],
  apply(ctx: Context) {
    const service = new BreadcrumbsService(ctx, ctx.editor, gpuiScopeHost());
    ctx.slots.register("statusbar", {
      id: "breadcrumbs.bar",
      order: 11,
      component: Breadcrumbs,
      props: { breadcrumbs: service, editor: ctx.editor, workspace: ctx.workspace, commands: ctx.commands, layout: ctx.layout },
    });
  },
};
