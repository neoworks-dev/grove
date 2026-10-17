// Plugins that break on purpose, so a profile row can show how a failure looks: one that fails
// to load, and one that loads and then throws while its slot entry draws. Neither takes the
// rest of the window with it.

import type { Context } from "@neoworks/extension-system";
import BrokenEntry from "./BrokenEntry.svelte";

export const failing = {
  name: "failing",
  apply() {
    throw new Error("this plugin always fails, to show how a failure looks");
  },
};

export const brokenEntry = {
  name: "broken-entry",
  inject: ["slots"],
  apply(ctx: Context) {
    ctx.slots.register("statusbar", { id: "broken-entry", order: 15, component: BrokenEntry });
  },
};
