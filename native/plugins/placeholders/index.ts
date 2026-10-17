// PLACEHOLDER. This plugin only gives the bottom panel something to show until the plugins that
// own those places exist (the terminal and problems). It is its own row in the core profile, so
// dropping it is deleting that row.

import type { Context } from "@neoworks/extension-system";
import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";
import warning from "@phosphor-icons/core/regular/warning.svg";
import Placeholder from "./Placeholder.svelte";

export const placeholderPanel = {
  name: "placeholder-panel",
  inject: ["slots"],
  apply(ctx: Context) {
    ctx.slots.register("panel.bottom", {
      id: "terminal",
      key: "terminal",
      order: 1,
      component: Placeholder,
      props: { title: "Terminal", icon: terminalWindow, note: "Placeholder. The terminal pane comes later." },
    });
    ctx.slots.register("panel.bottom", {
      id: "problems",
      key: "problems",
      order: 2,
      component: Placeholder,
      props: { title: "Problems", icon: warning, note: "Placeholder. Diagnostics come with language servers." },
    });
  },
};
