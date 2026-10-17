<!--
  The bottom panel as the frame draws it: the tabs are the `panel.bottom` slot's entries, with
  each tab's title and icon taken from its entry's props, and a tab's body is its entry. It draws
  nothing while the panel is closed or has no tabs.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import { useKernel } from "../../kernel/kernel";
  import Slot from "../../kernel/slots/Slot.svelte";
  import { size } from "../theme/tokens";
  import BottomPanel from "./BottomPanel.svelte";
  import type { SlotEntry } from "../../kernel/slots/registry";
  import type { PanelService } from "./service";
  import type { TabEntry } from "./TabStrip.svelte";

  let { panel }: { panel: PanelService } = $props();

  const kernel = useKernel();

  /** The text a tab entry names itself with, falling back to its id. */
  function titleOf(entryId: string, props: Record<string, unknown> | undefined): string {
    if (props && typeof props.title === "string") {
      return props.title;
    }
    return entryId;
  }

  /** The icon a tab entry names, if any. */
  function iconOf(props: Record<string, unknown> | undefined): string | undefined {
    if (props && typeof props.icon === "string") {
      return props.icon;
    }
    return undefined;
  }

  /** The tab an entry draws: keyed entries are told apart by their key, which every entry here has. */
  function tabOf(entry: SlotEntry): TabEntry {
    let tabId = entry.id;
    if (entry.key !== undefined) {
      tabId = entry.key;
    }
    return { id: tabId, title: titleOf(entry.id, entry.props), icon: iconOf(entry.props) };
  }

  /** The tab entries by their `order`; those that name none keep registration order after the rest. */
  function byOrder(entries: SlotEntry[]): SlotEntry[] {
    const position = (entry: SlotEntry) => (entry.order === undefined ? Number.MAX_SAFE_INTEGER : entry.order);
    return [...entries].sort((first, second) => position(first) - position(second));
  }

  const tabs = $derived<TabEntry[]>(byOrder(kernel.slots.entries("panel.bottom")).map(tabOf));
</script>

{#if panel.isOpen() && tabs.length > 0}
  <View style={{ height: size.panelHeight, shrink: 0, direction: "row" }}>
    <BottomPanel {tabs} bind:activeId={() => panel.activeId(), (tabId) => panel.select(tabId)} onclose={() => panel.close()}>
      {#snippet body(tab)}
        <Slot name="panel.bottom" key={tab.id} />
      {/snippet}
    </BottomPanel>
  </View>
{/if}
