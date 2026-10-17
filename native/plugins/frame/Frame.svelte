<!--
  The shell's layout: the header on top, then a row of the left rail, the sidebar, the main area
  with the bottom panel under it, and the right rail, the status bar below, and the overlays last
  so they draw on top. Every region is a slot, so this file knows no plugin. A rail shows only
  while something is on it. The regions with chrome of their own (sidebar, bottom panel, status
  bar) are drawn by the plugin that owns them, which fills the slot named `<region>.host`.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import { useKernel } from "../../kernel/kernel";
  import Slot from "../../kernel/slots/Slot.svelte";
  import Rail from "../rails/Rail.svelte";
  import { shell } from "../theme/tokens";

  let { mainKey }: { mainKey: string } = $props();

  const kernel = useKernel();

  const hasLeftRail = $derived(kernel.slots.entries("rail.left").length > 0);
  const hasRightRail = $derived(kernel.slots.entries("rail.right").length > 0);
</script>

<View style={shell}>
  <Slot name="header" />
  <View style={{ flex: 1, minHeight: 0, direction: "row", gap: 6 }}>
    {#if hasLeftRail}
      <Rail><Slot name="rail.left" /></Rail>
    {/if}
    <Slot name="sidebar.host" />
    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <Slot name="main" key={mainKey} />
      <Slot name="panel.host" />
    </View>
    {#if hasRightRail}
      <Rail><Slot name="rail.right" /></Rail>
    {/if}
  </View>
  <Slot name="statusbar.host" />
  <Slot name="overlay" />
</View>
