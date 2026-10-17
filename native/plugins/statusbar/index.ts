// The statusbar plugin draws the bar from the `statusbar` list slot. Other plugins add items by
// registering a component there; see `StatusHost.svelte` for how an item picks its side.

import type { Context } from "@neoworks/extension-system";
import StatusHost from "./StatusHost.svelte";

export const statusbar = {
  name: "statusbar",
  inject: ["slots"],
  apply(ctx: Context) {
    ctx.slots.register("statusbar.host", { id: "statusbar", component: StatusHost });
  },
};
