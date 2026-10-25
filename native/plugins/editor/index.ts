// The editor plugin: the `editor` service, the editor pane in the `main` slot with its tabs, the
// file shown in the status bar, and the commands and keys for opening, saving and closing files
// and moving between tabs. The two overlays it needs, the question about unsaved changes and the
// field for a path to open, go into the `overlay` slot.

import { invoke } from "@neoworks/svelte-gpui";
import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import { defineSettings, setting } from "../../kernel/settings";
import ConfirmClose from "./ConfirmClose.svelte";
import EditorFileStatus from "./EditorFileStatus.svelte";
import EditorModeStatus from "./EditorModeStatus.svelte";
import EditorMain from "./EditorMain.svelte";
import OpenFile from "./OpenFile.svelte";
import { debugDecorations, DEBUG_SOURCE } from "./debugDecorations";
import { gpuiDocumentHost } from "./documentHost";
import EditorIndentStatus from "./EditorIndentStatus.svelte";
import { LANGUAGE_COMMANDS, LANGUAGE_KEYS } from "./languageCommands";
import { EditorService, INDENT_CHOICES, indentFromSetting, indentLabel, type EditorOptions } from "./service";

export const editorSettings = defineSettings({
  keymap: setting.enum({
    label: "Keymap",
    description: "The keys the editor understands: VS Code's, or vim's modes, operators and motions.",
    default: "standard",
    options: [
      { value: "standard", label: "Standard" },
      { value: "vim", label: "Vim" },
    ],
    live: true,
  }),
  defaultIndent: setting.enum({
    label: "Default indentation",
    description: "How a file is indented when its own lines do not say. Files that do keep their own.",
    default: "spaces-4",
    options: [
      { value: "spaces-2", label: "2 spaces" },
      { value: "spaces-4", label: "4 spaces" },
      { value: "spaces-8", label: "8 spaces" },
      { value: "tabs", label: "Tabs" },
    ],
    live: true,
  }),
  smoothScroll: setting.boolean({
    label: "Smooth scrolling",
    description: "Glide on page jumps and mouse wheel notches instead of snapping.",
    default: true,
    live: true,
  }),
  indentGuides: setting.boolean({
    label: "Indent guides",
    description: "Draw a line per indentation level, with the one around the cursor brighter.",
    default: true,
    live: true,
  }),
  occurrenceHighlights: setting.boolean({
    label: "Highlight word occurrences",
    description: "Mark the other places the word under the cursor appears in view.",
    default: true,
    live: true,
  }),
});

type EditorConfig = {
  keymap: string;
  defaultIndent: string;
  smoothScroll: boolean;
  indentGuides: boolean;
  occurrenceHighlights: boolean;
};

/** What the host is told of the settings. */
function optionsOf(config: EditorConfig): EditorOptions {
  return {
    defaultIndent: indentFromSetting(config.defaultIndent),
    smoothScroll: config.smoothScroll,
    indentGuides: config.indentGuides,
    occurrenceHighlights: config.occurrenceHighlights,
  };
}

export const editor = {
  name: "editor",
  Config: editorSettings,
  inject: ["slots", "commands", "keymap", "menus", "layout", "settings", "palette"],
  apply(ctx: Context, config: EditorConfig) {
    const service = new EditorService(ctx, gpuiDocumentHost(), ctx.layout);
    service.setKeymap(config.keymap);
    service.setPendingSequenceSource(() => ctx.keymap.isPending());
    // In vim's normal mode space is the leader key; the editor leaves it to the keymap then.
    service.setLeaderKeySource(() => ctx.keymap.hasLeaderBindings());
    ctx.keymap.allowBareKeys(() => service.acceptsLeaderKey());
    const configure = (options: EditorOptions) => {
      service.configure(options).catch((error) => ctx.logger.warn(`editor: could not apply the settings: ${String(error)}`));
    };
    configure(optionsOf(config));
    ctx.settings.onLive((change) => {
      const live = change.config as EditorConfig;
      service.setKeymap(live.keymap);
      configure(optionsOf(live));
    });
    // Drawn between a pane's tabs and its text; plugins such as breadcrumbs register into it.
    ctx.slots.declare("editor.breadcrumbs", "list");
    // Drawn over the text of a pane's editor; entries position themselves where the editor says its keyed blocks are.
    ctx.slots.declare("editor.overlay", "list");
    ctx.slots.register("main", {
      id: "editor",
      key: "editor",
      component: EditorMain,
      props: { title: "Editor", header: false, service },
    });
    ctx.slots.register("statusbar", { id: "editor.mode", order: 5, component: EditorModeStatus, props: { service } });
    ctx.slots.register("statusbar", { id: "editor.file", order: 10, component: EditorFileStatus, props: { service } });
    ctx.slots.register("statusbar", {
      id: "editor.indent",
      order: 15,
      component: EditorIndentStatus,
      props: { align: "right", service, change: () => void ctx.commands.run("editor.changeIndent") },
    });
    ctx.slots.register("overlay", { id: "editor.confirmClose", order: 10, component: ConfirmClose, props: { service } });
    ctx.slots.register("overlay", { id: "editor.openFile", order: 11, component: OpenFile, props: { service } });
    registerFileCommands(ctx, service);
    registerEditCommands(ctx, service);
    registerLanguageCommands(ctx, service);
    registerKeymapCommand(ctx, service);
    registerIndentCommand(ctx, service);
    registerJumpCommand(ctx, service);
    registerDebugCommands(ctx, service);
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
  ctx.commands.register({ id: "file.closeTab", title: "Close tab", group: "File", when: hasTab, run: async () => { await service.closeActiveTab() } });
  ctx.commands.register({ id: "editor.save", title: "Save file", group: "Editor", when: hasTab, run: async () => { await service.save() } });
  ctx.commands.register({ id: "go.nextTab", title: "Next tab", group: "Go", when: hasTab, run: () => service.cycleTabs(1) });
  ctx.commands.register({ id: "go.previousTab", title: "Previous tab", group: "Go", when: hasTab, run: () => service.cycleTabs(-1) });
}

/** The commands that ask the language server, through the focused editor, about its cursor. */
function registerLanguageCommands(ctx: Context, service: EditorService): void {
  for (const { id, title, group, action } of LANGUAGE_COMMANDS) {
    ctx.commands.register({ id, title, group, when: () => service.hasFocusedView(), run: () => void service.actOnFocusedView(action) });
  }
}

/** The commands the Edit menu names that the focused pane's editor can carry out by itself. */
function registerEditCommands(ctx: Context, service: EditorService): void {
  const commands: [string, string, string][] = [
    ["edit.undo", "Undo", "undo"],
    ["edit.redo", "Redo", "redo"],
    ["edit.cut", "Cut", "cut"],
    ["edit.copy", "Copy", "copy"],
    ["edit.paste", "Paste", "paste_clipboard"],
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

/** The command that switches between the standard keys and vim's, and keeps the choice in the profile. */
function registerKeymapCommand(ctx: Context, service: EditorService): void {
  ctx.commands.register({
    id: "editor.toggleVim",
    title: "Toggle vim keys in the editor",
    group: "Editor",
    keywords: "vim keymap modal",
    run: async () => {
      const rowId = ctx.settings.rowIdOf("editor");
      if (rowId === undefined) {
        return;
      }
      const next = service.keymap() === "vim" ? "standard" : "vim";
      await ctx.settings.set(rowId, "keymap", next);
    },
  });
}

/** The command that shows jump labels in the focused editor, for people who would rather not remember the key. */
function registerJumpCommand(ctx: Context, service: EditorService): void {
  ctx.commands.register({
    id: "editor.jump",
    title: "Jump to a place on screen with labels",
    group: "Go",
    keywords: "flash jump label motion easymotion",
    when: () => service.hasFocusedView() && service.active() !== null,
    run: () => service.sendCommand("start_jump"),
  });
}

/** The command that lists the indentation styles and applies the one picked to the focused file. */
function registerIndentCommand(ctx: Context, service: EditorService): void {
  ctx.commands.register({
    id: "editor.changeIndent",
    title: "Change indentation of this file",
    group: "Editor",
    keywords: "indent tabs spaces width",
    when: () => service.hasFocusedView() && service.active() !== null,
    run: async () => {
      const items = INDENT_CHOICES.map((style) => ({ id: JSON.stringify(style), title: indentLabel(style) }));
      const current = service.active()?.indent;
      const activeId = current ? JSON.stringify(current) : undefined;
      const picked = await ctx.palette.pick(items, { placeholder: "Indent this file with", activeId });
      if (picked) {
        await service.setIndent(JSON.parse(picked.id));
      }
    },
  });
}

/**
 * The palette-only commands that put one decoration of each kind at the cursor of the active
 * file, and take them off again. They are for trying the decorations layer by hand: no menu or key.
 */
function registerDebugCommands(ctx: Context, service: EditorService): void {
  ctx.commands.register({
    id: "debug.addDecorations",
    title: "Debug: add test decorations at the cursor",
    group: "Debug",
    when: () => service.hasActiveTab(),
    run: async () => {
      const active = service.active();
      if (!active) {
        return;
      }
      const cursor = service.cursorOf(active.id) ?? { row: 0, column: 0, count: 1, selected: false };
      await service.setDecorations(active.path, DEBUG_SOURCE, debugDecorations(cursor));
    },
  });
  ctx.commands.register({
    id: "debug.clearDecorations",
    title: "Debug: remove test decorations",
    group: "Debug",
    when: () => service.hasActiveTab(),
    run: async () => {
      const active = service.active();
      if (active) {
        await service.clearDecorations(active.path, DEBUG_SOURCE);
      }
    },
  });
}

/** Binds the keys for the file commands, and stands the other bindings down while a prompt is open. */
function registerKeys(ctx: Context, service: EditorService): void {
  // The editor takes Ctrl-S itself, so these use keys it leaves alone and reach the keymap.
  ctx.keymap.bind([
    { id: "editor.save", keys: "ctrl+alt+s", command: "editor.save", description: "Save file" },
    { id: "editor.save.chord", keys: "ctrl+k f2", command: "editor.save", description: "Save file" },
    { id: "file.open", keys: "ctrl+o", command: "file.open", description: "Open file" },
    ...LANGUAGE_KEYS.map((key) => ({ id: key.command, ...key })),
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
