<!--
  The root layout, plainly: a header on top, then the left rail, the sidebar, the main area
  with the bottom panel under it and the right rail in a row, the status bar below, and the
  overlays last so they draw on top. Every region is a slot, so this file knows no plugin.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import Slot from "../../kernel/slots/Slot.svelte";

  let { mainKey, sidebarKey, panelKey }: { mainKey?: string; sidebarKey?: string; panelKey?: string } = $props();
</script>

<View style={{ flex: 1 }}>
  <Slot name="header" />
  <View style={{ flex: 1, direction: "row", minHeight: 0 }}>
    <View><Slot name="rail.left" /></View>
    <Slot name="sidebar" key={sidebarKey} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Slot name="main" key={mainKey} />
      <Slot name="panel.bottom" key={panelKey} />
    </View>
    <View><Slot name="rail.right" /></View>
  </View>
  <View style={{ direction: "row", gap: 16, paddingX: 16, paddingY: 6, background: "#111113" }}>
    <Slot name="statusbar" />
  </View>
  <Slot name="overlay" />
</View>
