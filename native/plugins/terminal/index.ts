// The terminal plugin: the `terminal` service, the terminal pane type in the `main` slot, the terminal
// tab of the bottom panel, and the commands and keys that open, show and hide terminals. The shells
// and what they draw are in the Rust host (`src/terminal/`).

import type { Context } from "@neoworks/extension-system";
import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";
import { gpuiTerminalHost } from "./host";
import { TERMINAL_PANE_TYPE, TERMINAL_PANEL_TAB, TerminalService } from "./service";
import TerminalPane from "./TerminalPane.svelte";
import TerminalPanel from "./TerminalPanel.svelte";

export const terminal = {
  name: "terminal",
  inject: ["slots", "commands", "keymap", "menus", "workspace", "panel", "layout", "editor"],
  apply(ctx: Context) {
    const service = new TerminalService(ctx, gpuiTerminalHost(), ctx.workspace, ctx.panel, ctx.layout, ctx.editor);
    ctx.slots.register("main", {
      id: "terminal",
      key: TERMINAL_PANE_TYPE,
      component: TerminalPane,
      props: { title: (leafId: string) => service.paneTitle(leafId), icon: terminalWindow, service, layout: ctx.layout },
    });
    // Order 1 keeps it the panel's first tab, which is what the panel shows until a tab is chosen.
    ctx.slots.register("panel.bottom", {
      id: "terminal",
      key: TERMINAL_PANEL_TAB,
      order: 1,
      component: TerminalPanel,
      props: { title: "Terminal", icon: terminalWindow, service },
    });
    registerCommands(ctx, service);
    registerKeys(ctx);
    ctx.menus.registerItems([
      { id: "terminal.toggle", menuId: "view", label: "Toggle Terminal", group: "3-panels", order: 5, commandId: "terminal.toggle", accelerator: "Ctrl `" },
      { id: "terminal.new", menuId: "view", label: "New Terminal", group: "3-panels", order: 6, commandId: "terminal.new", accelerator: "Ctrl Shift `" },
    ]);
  },
};

/** Registers the commands that show, hide and open terminals. */
function registerCommands(ctx: Context, service: TerminalService): void {
  ctx.commands.register({
    id: "terminal.toggle",
    title: "Toggle terminal",
    group: "Terminal",
    keywords: "shell console panel",
    run: () => service.togglePanel(),
  });
  ctx.commands.register({
    id: "terminal.new",
    title: "New terminal",
    group: "Terminal",
    keywords: "shell console panel",
    run: () => {
      service.newPanelTerminal();
    },
  });
  ctx.commands.register({
    id: "terminal.newPane",
    title: "New terminal in a pane",
    group: "Terminal",
    keywords: "shell console split",
    run: () => service.openInPane("row"),
  });
}

/** Binds the keys. The terminal view leaves these to the app, so they work while a terminal has the keyboard. */
function registerKeys(ctx: Context): void {
  ctx.keymap.bind([
    { id: "terminal.toggle", keys: "ctrl+`", command: "terminal.toggle", description: "Toggle terminal" },
    { id: "terminal.new", keys: "ctrl+shift+`", command: "terminal.new", description: "New terminal" },
    { id: "terminal.new.tilde", keys: "ctrl+shift+~", command: "terminal.new", description: "New terminal" },
  ]);
}
