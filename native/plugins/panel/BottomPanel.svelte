<!--
  The bottom panel: a tab strip over the body of the active tab. What a tab shows is the
  caller's `body` snippet. Tabs that have been opened stay mounted and are only hidden when
  another is active, so a terminal's scrollback survives switching tabs.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import PaneControls from "../layout/PaneControls.svelte";
  import { pane } from "../theme/tokens";
  import TabStrip, { type TabEntry } from "./TabStrip.svelte";

  interface Props {
    tabs: TabEntry[];
    /** The shown tab. Falls back to the first tab when it names none that exists. */
    activeId?: string;
    onselect?: (id: string) => void;
    onclose?: () => void;
    /** Draws one tab's body. */
    body: Snippet<[TabEntry]>;
  }

  let { tabs, activeId = $bindable(""), onselect, onclose, body }: Props = $props();

  let visitedIds = $state<Set<string>>(new Set());

  const activeTab = $derived(tabs.find((tab) => tab.id === activeId) ?? tabs[0]);
  const mountedTabs = $derived(tabs.filter((tab) => visitedIds.has(tab.id) || tab.id === activeTab?.id));

  /** Shows a tab, and keeps it mounted from now on. */
  function select(tabId: string): void {
    activeId = tabId;
    visitedIds = new Set([...visitedIds, tabId]);
    onselect?.(tabId);
  }
</script>

<View style={{ ...pane, flex: 1, minHeight: 0 }}>
  <TabStrip {tabs} activeId={activeTab?.id ?? ""} onselect={select}>
    {#snippet trailing()}
      {#if onclose}<PaneControls {onclose} />{/if}
    {/snippet}
  </TabStrip>
  <View style={{ flex: 1, minHeight: 0 }}>
    {#each mountedTabs as tab (tab.id)}
      <View style={{ flex: 1, minHeight: 0, display: tab.id === activeTab?.id ? "flex" : "none" }}>
        {@render body(tab)}
      </View>
    {/each}
  </View>
</View>
