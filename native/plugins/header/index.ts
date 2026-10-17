// The header plugin: the header bar in the frame's `header` slot and its three ends as list
// slots of their own, `header.left`, `header.center` and `header.right`. It fills them with the
// logo, the app menu, the command center and the window controls, and other plugins add more.

import type { Context } from "@neoworks/extension-system";
import { defineSettings, setting } from "../../kernel/settings";
import CommandCenterEntry from "./CommandCenterEntry.svelte";
import HeaderHost from "./HeaderHost.svelte";
import Logo from "./Logo.svelte";
import MenuBarEntry from "./MenuBarEntry.svelte";
import WindowControlsEntry from "./WindowControlsEntry.svelte";

export const headerSettings = defineSettings({
  title: setting.string({ label: "Title", description: "The text in the command center pill.", default: "grove" }),
  versionLabel: setting.string({
    label: "Build label",
    description: "The build label before the window buttons.",
    default: "v0.1.0 · native",
  }),
});

export const header = {
  name: "header",
  Config: headerSettings,
  inject: ["slots", "menus"],
  apply(ctx: Context, config: { title: string; versionLabel: string }) {
    const { title, versionLabel } = config;
    ctx.slots.declare("header.left", "list");
    ctx.slots.declare("header.center", "list");
    ctx.slots.declare("header.right", "list");
    ctx.slots.register("header", { id: "header", component: HeaderHost });
    ctx.slots.register("header.left", { id: "logo", order: 0, component: Logo });
    ctx.slots.register("header.left", { id: "menubar", order: 10, component: MenuBarEntry, props: { menus: ctx.menus } });
    ctx.slots.register("header.center", { id: "command-center", order: 0, component: CommandCenterEntry, props: { label: title } });
    ctx.slots.register("header.right", { id: "window-controls", order: 100, component: WindowControlsEntry, props: { versionLabel } });
  },
};
