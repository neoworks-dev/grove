<!--
  Opens the menu of an editor's actions where the pointer was pressed with the right button. The
  entries are the registry's items for `editor.context`, each running its command, greyed out
  while the command cannot run.
-->
<script lang="ts">
  import { ContextMenu, type MenuItem } from "@neoworks/svelte-gpui/ui";
  import type { CommandsService } from "../../kernel/commands/service";
  import type { ContextMenuRequest, EditorService } from "../editor/service";
  import { itemsForMenu, menuRows, type MenuBarItem } from "../menus/menuModel";
  import type { MenusService } from "../menus/service";
  import { CONTEXT_MENU_ID, SELECTION_COMMANDS } from "./items";

  interface Props {
    editor: EditorService;
    menus: MenusService;
    commands: CommandsService;
  }

  let { editor, menus, commands }: Props = $props();

  let menu = $state<{ openAt(x: number, y: number, items?: MenuItem[]): void } | undefined>();

  // A right press in any editor opens the menu at the pointer.
  $effect(() => editor.onContextMenu((request) => open(request)));

  /** Opens the menu for a press, with the entries that apply to the editor now. */
  function open(request: ContextMenuRequest): void {
    const items = itemsForMenu(menus.items(), CONTEXT_MENU_ID);
    const rows = menuRows(items, run, { isDisabled: (item) => !canRun(item, request) });
    menu?.openAt(request.x, request.y, rows);
  }

  /** Whether an entry's command can run now, given whether text is selected. */
  function canRun(item: MenuBarItem, request: ContextMenuRequest): boolean {
    if (item.commandId === undefined || !commands.canRun(item.commandId)) {
      return false;
    }
    return request.hasSelection || !SELECTION_COMMANDS.has(item.commandId);
  }

  /** Runs the command of the entry that was chosen. */
  function run(item: MenuBarItem): void {
    if (item.commandId !== undefined) {
      void commands.run(item.commandId);
    }
  }
</script>

<ContextMenu bind:this={menu} menuStyle={{ minWidth: 220 }} />
