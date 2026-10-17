// The breadcrumbs plugin: the `breadcrumbs` service, and the bar it puts above each editor in the
// editor pane's `editor.breadcrumbs` slot. It is its own plugin so a profile row can switch it off.

import type { Context } from "@neoworks/extension-system";
import Breadcrumbs from "./Breadcrumbs.svelte";
import { gpuiScopeHost } from "./scopeHost";
import { BreadcrumbsService } from "./service";

export const breadcrumbs = {
  name: "breadcrumbs",
  inject: ["slots", "commands", "editor", "workspace"],
  apply(ctx: Context) {
    const service = new BreadcrumbsService(ctx, ctx.editor, gpuiScopeHost());
    ctx.slots.register("editor.breadcrumbs", {
      id: "breadcrumbs.bar",
      component: Breadcrumbs,
      props: { breadcrumbs: service, editor: ctx.editor, workspace: ctx.workspace, commands: ctx.commands },
    });
  },
};
