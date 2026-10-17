// The layout plugin: the `layout` service and the main area it draws, registered into the frame's
// `main` slot under the key "workbench". Each pane of the tree shows another `main` entry by key,
// so the editor and the empty pane below are panes like any other. The split, close and focus
// commands, and the keys that run them, belong here too.

import type { Context } from "@neoworks/extension-system";
import EmptyPane from "./EmptyPane.svelte";
import LayoutView from "./LayoutView.svelte";
import { LayoutService } from "./service";

export interface LayoutConfig {
  /** The pane type of the first pane; "editor" by default. */
  defaultPane?: string;
  /** The pane type a split opens; by default, the type of the pane that was split. */
  newPane?: string;
}

export const layout = {
  name: "layout",
  inject: ["slots", "commands", "keymap"],
  apply(ctx: Context, config: LayoutConfig | undefined) {
    let defaultPane = "editor";
    let newPane: string | null = null;
    if (config && config.defaultPane !== undefined) {
      defaultPane = config.defaultPane;
    }
    if (config && config.newPane !== undefined) {
      newPane = config.newPane;
    }
    const service = new LayoutService(ctx, defaultPane, newPane);
    ctx.slots.register("main", { id: "workbench", key: "workbench", component: LayoutView, props: { layout: service } });
    ctx.slots.register("main", { id: "empty", key: "empty", component: EmptyPane, props: { title: "Empty" } });
    registerCommands(ctx, service);
  },
};

/** Registers the commands that act on the layout, and the keys that run them. */
function registerCommands(ctx: Context, service: LayoutService): void {
  const hasSeveralPanes = () => service.leafCount() > 1;
  ctx.commands.register({ id: "window.splitRight", title: "Split right", group: "Window", run: () => service.splitFocused("row") });
  ctx.commands.register({ id: "window.splitDown", title: "Split down", group: "Window", run: () => service.splitFocused("column") });
  ctx.commands.register({ id: "window.close", title: "Close pane", group: "Window", when: hasSeveralPanes, run: () => service.closeFocused() });
  ctx.commands.register({ id: "window.focusNext", title: "Focus next pane", group: "Window", when: hasSeveralPanes, run: () => service.focusNext() });
  ctx.keymap.bind([
    { id: "window.splitRight", keys: "ctrl+k v", command: "window.splitRight", description: "Split right" },
    { id: "window.splitDown", keys: "ctrl+k s", command: "window.splitDown", description: "Split down" },
    { id: "window.close", keys: "ctrl+k w", command: "window.close", description: "Close pane" },
    { id: "window.focusNext", keys: "ctrl+k n", command: "window.focusNext", description: "Focus next pane" },
  ]);
}
