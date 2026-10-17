// PLACEHOLDERS. These two plugins only give the rail and the bottom panel something to show until
// the plugins that own those places exist (git changes, the terminal and problems). Each is its own
// row in the core profile, so dropping one is deleting that row.

import type { Context } from "@neoworks/extension-system";
import gitBranch from "@phosphor-icons/core/regular/git-branch.svg";
import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";
import warning from "@phosphor-icons/core/regular/warning.svg";
import Placeholder from "./Placeholder.svelte";

export const placeholderSidebar = {
  name: "placeholder-sidebar",
  inject: ["sidebar"],
  apply(ctx: Context) {
    ctx.sidebar.registerView({
      id: "git",
      title: "Git changes",
      icon: gitBranch,
      order: 2,
      component: Placeholder,
      props: { title: "Git changes", note: "Placeholder. Changes come with the sidecar." },
    });
  },
};

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
