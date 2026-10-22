<script lang="ts">
  // A tiny trend, drawn inline: the label, the line and the last value.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { fmt, niceScale, seriesPoints, seriesSvg } from "./charts";
  import { numbers, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;

  const values = $derived(numbers(node, "values"));
  const W = 110;
  const H = 28;
  const scale = $derived(niceScale(Math.min(...values, 0), Math.max(...values, 1), 1));
  const lo = $derived(Math.min(...values));
  const hi = $derived(Math.max(...values));
  const svg = $derived.by(() => {
    const own = { lo, hi: hi === lo ? lo + 1 : hi, step: 1, ticks: [] };
    const points = seriesPoints(values, scale.ticks.length > 0 ? own : own, W - 4, H - 6).map((point) => ({ x: point.x + 2, y: point.y + 3 }));
    return seriesSvg(points, W, H, { area: false, stroke: 1.6 });
  });
</script>

<View style={{ direction: "row", align: "center", gap: 10, alignSelf: "start" }}>
  {#if str(node, "label")}
    <Text style={{ color: p.muted }}>{str(node, "label")}</Text>
  {/if}
  {#if values.length > 0}
    <Icon {svg} color={p.accent} style={{ width: W, height: H }} />
    <Text style={{ fontWeight: "semibold", fontFamily: "mono", fontSize: 12 }}>{fmt(values.at(-1) ?? 0)}</Text>
  {/if}
</View>
