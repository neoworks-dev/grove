// The editor plugin: the `editor` service, the editor pane in the `main` slot with its tabs, the
// file shown in the status bar, and the commands and keys for opening, saving and closing files
// and moving between tabs. The two overlays it needs, the question about unsaved changes and the
// field for a path to open, go into the `overlay` slot.

import { invoke } from "@neoworks/svelte-gpui";
import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import ConfirmClose from "./ConfirmClose.svelte";
import EditorFileStatus from "./EditorFileStatus.svelte";
import EditorMain from "./EditorMain.svelte";
import OpenFile from "./OpenFile.svelte";
import { gpuiDocumentHost } from "./documentHost";
import { EditorService } from "./service";

export const editor = {
  name: "editor",
  inject: ["slots", "commands", "keymap", "menus", "layout"],
  apply(ctx: Context) {
    const service = new EditorService(ctx, gpuiDocumentHost(), ctx.layout);
    ctx.slots.register("main", {
      id: "editor",
      key: "editor",
      component: EditorMain,
      props: { title: "Editor", service },
    });
    ctx.slots.register("statusbar", { id: "editor.file", order: 10, component: EditorFileStatus, props: { service } });
    ctx.slots.register("overlay", { id: "editor.confirmClose", order: 10, component: ConfirmClose, props: { service } });
    ctx.slots.register("overlay", { id: "editor.openFile", order: 11, component: OpenFile, props: { service } });
    registerFileCommands(ctx, service);
    registerEditCommands(ctx, service);
    registerKeys(ctx, service);
    ctx.menus.registerItems([
      { id: "file.open", menuId: "file", label: "Open File…", group: "1-open", order: 0, commandId: "file.open", accelerator: "Ctrl O" },
    ]);
    openStartFile(ctx, service);
  },
};

/** Registers the commands for opening, saving and closing files and moving between tabs. */
function registerFileCommands(ctx: Context, service: EditorService): void {
  const hasTab = () => service.hasActiveTab();
  ctx.commands.register({ id: "file.open", title: "Open file", group: "File", run: () => service.requestOpenFile() });
  ctx.commands.register({ id: "file.closeTab", title: "Close tab", group: "File", when: hasTab, run: () => void service.closeActiveTab() });
  ctx.commands.register({ id: "editor.save", title: "Save file", group: "Editor", when: hasTab, run: () => void service.save() });
  ctx.commands.register({ id: "go.nextTab", title: "Next tab", group: "Go", when: hasTab, run: () => service.cycleTabs(1) });
  ctx.commands.register({ id: "go.previousTab", title: "Previous tab", group: "Go", when: hasTab, run: () => service.cycleTabs(-1) });
}

/** The commands the Edit menu names that the focused pane's editor can carry out by itself. */
function registerEditCommands(ctx: Context, service: EditorService): void {
  const commands: [string, string, string][] = [
    ["edit.undo", "Undo", "undo"],
    ["edit.redo", "Redo", "redo"],
    ["edit.selectAll", "Select all", "select_all"],
  ];
  for (const [id, title, type] of commands) {
    ctx.commands.register({
      id,
      title,
      group: "Edit",
      when: () => service.hasFocusedView(),
      run: () => service.sendCommand(type),
    });
  }
}

/** Binds the keys for the file commands, and stands the other bindings down while a prompt is open. */
function registerKeys(ctx: Context, service: EditorService): void {
  // The editor takes Ctrl-S itself, so these use keys it leaves alone and reach the keymap.
  ctx.keymap.bind([
    { id: "editor.save", keys: "ctrl+alt+s", command: "editor.save", description: "Save file" },
    { id: "editor.save.chord", keys: "ctrl+k f2", command: "editor.save", description: "Save file" },
    { id: "file.open", keys: "ctrl+o", command: "file.open", description: "Open file" },
    { id: "file.closeTab", keys: "ctrl+w", command: "file.closeTab", description: "Close tab" },
    { id: "go.nextTab", keys: "ctrl+tab", command: "go.nextTab", description: "Next tab" },
    { id: "go.previousTab", keys: "ctrl+shift+tab", command: "go.previousTab", description: "Previous tab" },
  ]);
  ctx.keymap.subscribe(KeyPriority.dialog, (event) => {
    if (event.key !== "Escape" || service.prompt() === null) {
      return false;
    }
    service.cancelPrompt();
    return true;
  });
  // A prompt types into its own field, so the bindings do not run under it.
  ctx.keymap.subscribe(KeyPriority.overlay, () => service.prompt() !== null);
}

/** Opens the file the host was started with, `GROVE_OPEN` or the scratch copy of a sample. */
function openStartFile(ctx: Context, service: EditorService): void {
  ctx.effect(() => {
    void invoke<string>("initial_file").then((path) => service.open(path));
    return () => {};
  }, "editor.startFile");
}
