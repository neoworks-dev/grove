// The panel plugin: the `panel` service, the host the frame draws the bottom panel with, and the
// command and key that show or hide it. Its config's `open` says whether it starts showing.

import type { Context } from "@neoworks/extension-system";
import PanelHost from "./PanelHost.svelte";
import { PanelService } from "./service";

export interface PanelConfig {
  /** Whether the panel is showing at start; true by default. */
  open?: boolean;
}

export const panel = {
  name: "panel",
  inject: ["slots", "commands", "keymap"],
  apply(ctx: Context, config: PanelConfig | undefined) {
    let openAtStart = true;
    if (config && config.open !== undefined) {
      openAtStart = config.open;
    }
    const service = new PanelService(ctx, openAtStart);
    ctx.slots.register("panel.host", { id: "panel", component: PanelHost, props: { panel: service } });
    ctx.commands.register({
      id: "panel.toggle",
      title: "Toggle bottom panel",
      group: "View",
      run: () => service.toggle(),
    });
    ctx.keymap.bind({ id: "panel.toggle", keys: "ctrl+j", command: "panel.toggle", description: "Toggle bottom panel" });
  },
};
