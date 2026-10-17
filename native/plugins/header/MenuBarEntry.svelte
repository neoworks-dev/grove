<!--
  The app menu wired to the kernel: its menus and items come from the `menus` service, choosing
  an item runs its command, and an item whose command is not registered or cannot run now is drawn
  greyed out. Shortcuts shown are the keys the keymap really has for the command.
-->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import type { MenusService } from "../menus/service";
  import type { MenuBarItem } from "../menus/menuModel";
  import MenuBar from "./MenuBar.svelte";

  let { menus }: { menus: MenusService } = $props();

  const kernel = useKernel();

  /** Runs the command an item names. */
  function run(item: MenuBarItem): void {
    if (item.commandId === undefined) {
      return;
    }
    void kernel.commands.run(item.commandId);
  }

  /** Whether the item's command is missing or says it cannot run now. Reactive on the command's registration. */
  function cannotRun(item: MenuBarItem): boolean {
    if (item.commandId === undefined) {
      return true;
    }
    if (kernel.commands.get(item.commandId) === undefined) {
      return true;
    }
    return !kernel.commands.canRun(item.commandId);
  }

  /** The keys bound to the item's command, as keycaps joined by spaces; nothing when it has none. */
  function keysOf(item: MenuBarItem): string | undefined {
    if (item.commandId === undefined) {
      return undefined;
    }
    const labels = kernel.keymap.keysFor(item.commandId);
    if (labels.length === 0) {
      return "";
    }
    return labels.join(" ");
  }
</script>

<MenuBar menus={menus.menus()} items={menus.items()} onrun={run} isDisabled={cannotRun} acceleratorFor={keysOf} />
