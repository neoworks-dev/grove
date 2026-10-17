<!--
  The app header: a left end, a centred middle and a right end, each a snippet other plugins
  fill. The middle keeps its place however wide the ends are (Grove's header was a
  `1fr auto 1fr` grid, so here the two ends share what the middle leaves).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import { size, space } from "../theme/tokens";

  interface Props {
    left?: Snippet;
    center?: Snippet;
    right?: Snippet;
  }

  let { left, center, right }: Props = $props();
</script>

<View style={{ direction: "row", align: "center", height: size.headerHeight, shrink: 0, paddingX: space.xs, gap: space.sm }}>
  <View style={{ flex: 1, minWidth: 0, direction: "row", align: "center", gap: 6 }}>
    {@render left?.()}
  </View>
  <View style={{ shrink: 0, direction: "row", align: "center" }}>
    {@render center?.()}
  </View>
  <View style={{ flex: 1, minWidth: 0, direction: "row", align: "center", justify: "end" }}>
    {@render right?.()}
  </View>
</View>
