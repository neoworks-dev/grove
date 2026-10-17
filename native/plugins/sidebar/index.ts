// The sidebar plugin: the `sidebar` service, the host the frame draws it with, and the command
// and key that show or hide it. Its config can name a view to open at start.

import type { Context } from "@neoworks/extension-system";
import { defineSettings, setting } from "../../kernel/settings";
import SidebarHost from "./SidebarHost.svelte";
import { SidebarService } from "./service";

export const sidebarSettings = defineSettings({
  open: setting.enum({
    label: "Open view",
    description: "The view the sidebar shows. Changing it opens that view at once; none keeps the sidebar closed.",
    default: "",
    options: "sidebar-views",
    live: true,
  }),
  toggleKeys: setting.keybinding({
    label: "Toggle sidebar",
    description: "The key sequence that shows or hides the sidebar.",
    default: "ctrl+b",
  }),
});

export const sidebar = {
  name: "sidebar",
  Config: sidebarSettings,
  inject: ["slots", "rails", "commands", "keymap", "settings"],
  apply(ctx: Context, config: { open: string; toggleKeys: string }) {
    let openAtStart: string | undefined;
    if (config.open !== "") {
      openAtStart = config.open;
    }
    const service = new SidebarService(ctx, openAtStart);
    ctx.settings.registerOptions("sidebar-views", () => [
      { value: "", label: "None" },
      ...service.views().map((view) => ({ value: view.id, label: view.title })),
    ]);
    ctx.settings.onLive((change) => {
      if (change.config.open === "") {
        service.close();
        return;
      }
      service.open(change.config.open as string);
    });
    ctx.slots.register("sidebar.host", { id: "sidebar", component: SidebarHost, props: { sidebar: service } });
    ctx.commands.register({
      id: "sidebar.toggle",
      title: "Toggle sidebar",
      group: "View",
      run: () => service.toggleVisible(),
    });
    if (config.toggleKeys !== "") {
      ctx.keymap.bind({ id: "sidebar.toggle", keys: config.toggleKeys, command: "sidebar.toggle", description: "Toggle sidebar" });
    }
  },
};
