// Grove's base app menu, from `lib/coreMenu.ts`, as plain data. Every item names a command; the
// commands themselves (undo, close tab, open folder, …) are registered by the plugins that own
// them, so this file has no behaviour and no dependency on the kernel.

import type { MenuBarItem, TopMenu } from "./menuModel";

export const CORE_MENUS: TopMenu[] = [
  { id: "file", label: "File", order: 1 },
  { id: "edit", label: "Edit", order: 2 },
  { id: "view", label: "View", order: 3 },
  { id: "go", label: "Go", order: 4 },
  { id: "window", label: "Window", order: 5 },
  { id: "help", label: "Help", order: 6 },
];

/** Builds one item of a core menu. */
function item(
  menuId: string,
  group: string,
  order: number,
  label: string,
  commandId: string,
  accelerator?: string,
): MenuBarItem {
  return { id: commandId, menuId, label, group, order, commandId, accelerator };
}

export const CORE_MENU_ITEMS: MenuBarItem[] = [
  item("file", "1-open", 1, "Open Folder…", "repo.open"),
  item("file", "5-close", 1, "Close Tab", "file.closeTab", "␣ b d"),
  item("file", "9-quit", 1, "Quit", "app.quit"),

  item("edit", "1-history", 1, "Undo", "edit.undo"),
  item("edit", "1-history", 2, "Redo", "edit.redo"),
  item("edit", "2-clipboard", 1, "Cut", "edit.cut"),
  item("edit", "2-clipboard", 2, "Copy", "edit.copy"),
  item("edit", "2-clipboard", 3, "Paste", "edit.paste"),
  item("edit", "3-select", 1, "Select All", "edit.selectAll"),
  item("edit", "4-find", 1, "Find", "edit.find"),
  item("edit", "4-find", 2, "Undo History", "undotree.open", "␣ s u"),

  item("view", "3-panels", 0, "Toggle Sidebar", "sidebar.toggle"),
  item("view", "3-panels", 1, "Toggle Bottom Panel", "panel.toggle", "␣ j"),
  item("view", "3-panels", 2, "Toggle Logs Panel", "view.toggleLogs"),
  item("view", "3-panels", 3, "Toggle Agent Panel", "view.toggleAgent"),
  item("view", "3-panels", 4, "Focus Mode", "view.focusMode", "␣ z"),
  item("view", "5-general", 1, "Command Palette…", "palette.open", "F1"),
  item("view", "5-general", 2, "Color Theme…", "theme.switch"),
  item("view", "5-general", 3, "Preferences", "view.preferences", "␣ ,"),
  item("view", "5-general", 4, "Keyboard Shortcuts", "view.keybindings", "␣ k"),
  item("view", "5-general", 5, "Connect Chrome", "view.connectChrome"),

  item("go", "1-find", 1, "Go to File…", "files.find", "␣ ␣"),
  item("go", "1-find", 2, "Go to Symbol in Editor…", "symbols.open", "␣ s s"),
  item("go", "1-find", 3, "Go to Symbol in Workspace…", "symbols.workspace", "␣ s S"),
  item("go", "2-tabs", 1, "Next Tab", "go.nextTab"),
  item("go", "2-tabs", 2, "Previous Tab", "go.previousTab"),

  item("window", "1-split", 1, "Split Right", "window.splitRight", "␣ w v"),
  item("window", "1-split", 2, "Split Down", "window.splitDown", "␣ w s"),
  item("window", "2-close", 1, "Close Pane", "window.close", "␣ w q"),

  item("help", "1-links", 1, "Documentation", "help.documentation"),
  item("help", "1-links", 2, "neoworks.dev", "help.neoworks"),
];
