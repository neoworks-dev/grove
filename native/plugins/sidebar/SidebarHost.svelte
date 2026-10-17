<!--
  The sidebar: a pane of fixed width with the open view's title over its body. It draws nothing
  while the sidebar is closed. The body is the `sidebar` slot's entry for the open view's key.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import Slot from "../../kernel/slots/Slot.svelte";
  import PaneControls from "../layout/PaneControls.svelte";
  import { colors, fontSize, pane, size } from "../theme/tokens";
  import type { SidebarService } from "./service";

  let { sidebar }: { sidebar: SidebarService } = $props();

  const view = $derived(sidebar.activeView());
</script>

{#if view}
  <View style={{ ...pane, width: size.sidebarWidth, shrink: 0 }}>
    <View style={{ direction: "row", align: "center", height: 28, shrink: 0, paddingLeft: 12, paddingRight: 4 }}>
      <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xs, color: colors.muted }}>{view.title}</Text>
      <PaneControls onclose={() => sidebar.close()} />
    </View>
    <View style={{ flex: 1, minHeight: 0 }}>
      <Slot name="sidebar" key={view.id} />
    </View>
  </View>
{/if}
