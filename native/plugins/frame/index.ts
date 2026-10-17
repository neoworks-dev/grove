// The frame plugin owns the root layout: it declares the places the rest of the UI plugs into
// (header, rails, sidebar, main, bottom panel, status bar, overlays) and registers the
// component that lays them out. The visual components for those places come from other plugins.

import type { Context } from "@neoworks/extension-system";
import type { SlotKind } from "../../kernel/slots";
import Frame from "./Frame.svelte";

export interface FrameConfig {
  /** The key of the `main` entry to show. */
  main?: string;
  /** The key of the `sidebar` entry to show, if any. */
  sidebar?: string;
  /** The key of the `panel.bottom` entry to show, if any. */
  panel?: string;
}

const ROOT_SLOTS: [string, SlotKind][] = [
  ["header", "single"],
  ["rail.left", "list"],
  ["sidebar", "keyed"],
  ["main", "keyed"],
  ["rail.right", "list"],
  ["panel.bottom", "keyed"],
  ["statusbar", "list"],
  ["overlay", "list"],
];

export const frame = {
  name: "frame",
  inject: ["slots"],
  apply(ctx: Context, config: FrameConfig | undefined) {
    for (const [name, kind] of ROOT_SLOTS) {
      ctx.slots.declare(name, kind);
    }
    const settings: FrameConfig = {};
    Object.assign(settings, config);
    if (settings.main === undefined) {
      settings.main = "editor";
    }
    ctx.slots.register("root", {
      id: "frame",
      component: Frame,
      props: { mainKey: settings.main, sidebarKey: settings.sidebar, panelKey: settings.panel },
    });
  },
};
