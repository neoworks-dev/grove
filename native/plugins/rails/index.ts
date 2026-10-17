// The rails plugin provides the `rails` service. The rail columns themselves are drawn by the
// frame, which shows one only while some plugin has put a button on it.

import type { Context } from "@neoworks/extension-system";
import RailButton from "./RailButton.svelte";
import { RailsService } from "./service";

export const rails = {
  name: "rails",
  inject: ["slots"],
  apply(ctx: Context) {
    new RailsService(ctx, RailButton);
  },
};
