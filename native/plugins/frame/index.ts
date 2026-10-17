// The frame plugin owns the root layout: it declares the places the rest of the UI plugs into
// and registers the component that lays them out. The visual components for those places come
// from other plugins.
//
// The slots named in the plan are the content slots: `header`, `rail.left`, `sidebar`, `main`,
// `rail.right`, `panel.bottom`, `statusbar` and `overlay`. The three regions that draw their own
// chrome from their content get a single `<region>.host` slot as well, which their plugin fills:
// `sidebar.host`, `panel.host` and `statusbar.host`. `main` shows the entry named by the config,
// which is the layout plugin's "workbench" unless a profile asks for a pane type directly.

import { window } from "@neoworks/svelte-gpui";
import type { Context } from "@neoworks/extension-system";
import type { SlotKind } from "../../kernel/slots";
import Frame from "./Frame.svelte";

export interface FrameConfig {
  /** The key of the `main` entry to show; "workbench", the split layout, by default. */
  main?: string;
}

const ROOT_SLOTS: [string, SlotKind][] = [
  ["header", "single"],
  ["rail.left", "list"],
  ["sidebar", "keyed"],
  ["sidebar.host", "single"],
  ["main", "keyed"],
  ["rail.right", "list"],
  ["panel.bottom", "keyed"],
  ["panel.host", "single"],
  ["statusbar", "list"],
  ["statusbar.host", "single"],
  ["overlay", "list"],
];

export const frame = {
  name: "frame",
  inject: ["slots", "commands"],
  apply(ctx: Context, config: FrameConfig | undefined) {
    for (const [name, kind] of ROOT_SLOTS) {
      ctx.slots.declare(name, kind);
    }
    let mainKey = "workbench";
    if (config && config.main !== undefined) {
      mainKey = config.main;
    }
    ctx.slots.register("root", { id: "frame", component: Frame, props: { mainKey } });
    ctx.commands.register({ id: "app.quit", title: "Quit", group: "App", run: () => window.close() });
  },
};
