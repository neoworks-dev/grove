// The sidebar plugin: the `sidebar` service, the host the frame draws it with, and the command
// and key that show or hide it. Its config can name a view to open at start.

import type { Context } from "@neoworks/extension-system";
import SidebarHost from "./SidebarHost.svelte";
import { SidebarService } from "./service";

export interface SidebarConfig {
  /** The id of the view to show when the app starts; none by default. */
  open?: string;
}

export const sidebar = {
  name: "sidebar",
  inject: ["slots", "rails", "commands", "keymap"],
  apply(ctx: Context, config: SidebarConfig | undefined) {
    let openAtStart: string | undefined;
    if (config) {
      openAtStart = config.open;
    }
    const service = new SidebarService(ctx, openAtStart);
    ctx.slots.register("sidebar.host", { id: "sidebar", component: SidebarHost, props: { sidebar: service } });
    ctx.commands.register({
      id: "sidebar.toggle",
      title: "Toggle sidebar",
      group: "View",
      run: () => service.toggleVisible(),
    });
    ctx.keymap.bind({ id: "sidebar.toggle", keys: "ctrl+b", command: "sidebar.toggle", description: "Toggle sidebar" });
  },
};
