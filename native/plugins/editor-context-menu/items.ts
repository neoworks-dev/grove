// What the editor's right-click menu offers, as items of the app's menu registry under the menu id
// `editor.context`. Each item runs a command by id and is left out while no plugin has registered
// that command, so the language actions appear once the language plugin that owns them is loaded.
// Any plugin can add its own items to the same menu.

import type { MenuBarItem } from "../menus/menuModel";

/** The id of the menu in the registry. It is no top-level menu, so the menu bar never shows it. */
export const CONTEXT_MENU_ID = "editor.context";

/** The commands that act on the selected text, which cannot run while nothing is selected. */
export const SELECTION_COMMANDS: ReadonlySet<string> = new Set(["edit.cut", "edit.copy"]);

/** Whether the registry has a command with this id, whether or not it can run now. */
export type HasCommand = (commandId: string) => boolean;

/** One entry of the menu. */
function entry(group: string, order: number, label: string, commandId: string, hasCommand: HasCommand, accelerator?: string): MenuBarItem {
  return {
    id: `${CONTEXT_MENU_ID}.${commandId}`,
    menuId: CONTEXT_MENU_ID,
    label,
    group,
    order,
    commandId,
    accelerator,
    when: () => hasCommand(commandId),
  };
}

/**
 * The editor's own entries: the clipboard, the actions of the language server, the file's git
 * changes, and its path. A separator is drawn between the groups.
 */
export function contextMenuItems(hasCommand: HasCommand): MenuBarItem[] {
  return [
    entry("1-clipboard", 1, "Cut", "edit.cut", hasCommand, "Ctrl X"),
    entry("1-clipboard", 2, "Copy", "edit.copy", hasCommand, "Ctrl C"),
    entry("1-clipboard", 3, "Paste", "edit.paste", hasCommand, "Ctrl V"),
    entry("1-clipboard", 4, "Select All", "edit.selectAll", hasCommand, "Ctrl A"),

    entry("2-language", 1, "Go to Definition", "editor.goToDefinition", hasCommand, "F12"),
    entry("2-language", 2, "Find References", "editor.findReferences", hasCommand, "Shift F12"),
    entry("2-language", 3, "Rename Symbol", "editor.rename", hasCommand, "F2"),
    entry("2-language", 4, "Code Actions", "editor.codeAction", hasCommand, "Ctrl ."),
    entry("2-language", 5, "Format Document", "editor.formatDocument", hasCommand, "Shift Alt F"),

    entry("3-git", 1, "Stage Hunk", "git.stageHunk", hasCommand),
    entry("3-git", 2, "Revert Hunk", "git.revertHunk", hasCommand),
    entry("3-git", 3, "Preview Hunk", "git.previewHunk", hasCommand),
    entry("3-git", 4, "Open Changes", "diff.openFile", hasCommand),

    entry("4-file", 1, "Copy Path", "editor.copyPath", hasCommand),
    entry("4-file", 2, "Copy Relative Path", "editor.copyRelativePath", hasCommand),
    entry("4-file", 3, "Reveal in Explorer", "explorer.reveal", hasCommand),
    entry("4-file", 4, "Reveal in File Manager", "editor.revealInFileManager", hasCommand),
  ];
}
