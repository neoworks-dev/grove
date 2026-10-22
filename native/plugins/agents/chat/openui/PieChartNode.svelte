<script lang="ts">
  // Shares of a whole: a pie, or with `donut` a ring, and a legend with each share's percentage.
  // Each slice is an SVG the Icon tints.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { percent, pieSlices, seriesColor, sliceSvg } from "./charts";
  import { bool, nodes, num, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;

  const slices = $derived(
    pieSlices(nodes(node, "slices").map((s) => ({ label: str(s, "label") ?? "", value: num(s, "value") ?? 0 }))),
  );
  const donut = $derived(bool(node, "donut") === true);
  const size = $derived(Math.max(90, Math.min(150, Math.floor(width * 0.4))));
  const hole = $derived(donut ? Math.round(size * 0.3) : 0);
</script>

<View style={{ direction: "row", wrap: true, align: "center", gap: 20 }}>
  <View style={{ size, shrink: 0 }}>
    {#each slices as slice, index}
      {#if slice.share > 0}
        <Icon svg={sliceSvg(size, hole, slice)} color={seriesColor(p, index)} style={{ position: "absolute", left: 0, top: 0, size }} />
      {/if}
    {/each}
  </View>
  <View style={{ gap: 6, flex: 1, minWidth: 140 }}>
    {#each slices as slice, index}
      <View style={{ direction: "row", align: "center", gap: 8 }}>
        <View style={{ size: 10, radius: 3, background: seriesColor(p, index) }} />
        <Text style={{ flex: 1, minWidth: 0, truncate: true }}>{slice.label}</Text>
        <Text style={{ color: p.muted, fontFamily: "mono", fontSize: 12 }}>{percent(slice.share)}</Text>
      </View>
    {/each}
  </View>
</View>
