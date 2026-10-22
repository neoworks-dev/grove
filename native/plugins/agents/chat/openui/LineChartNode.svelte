<script lang="ts">
  // Lines (or filled areas) over labels, one colour per series, with a value axis, a gridline per
  // step and the labels along the foot, thinned until they do not touch. Each series is an SVG the
  // Icon tints, so the lines are smooth.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { fmt, niceScale, seriesColor, seriesPoints, seriesSvg } from "./charts";
  import { labelStep } from "./bars";
  import Legend from "./Legend.svelte";
  import { nodes, numbers, strings } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;

  const area = $derived(node.component === "AreaChart");
  const labels = $derived(strings(node, "labels"));
  const series = $derived(
    nodes(node, "series").map((s) => ({ name: (s.props["name"] as string | undefined) ?? "", values: numbers(s, "values") })),
  );
  const chart = $derived(Math.min(width, 640));
  const PLOT = 170;
  const AXIS = 44;
  const PAD = 4;
  // Points sit a little in from the edges, so the first and last label have room.
  const inset = 14;
  const plot = $derived(chart - AXIS - 4);
  const inner = $derived(plot - inset * 2);
  const all = $derived(series.flatMap((s) => s.values));
  const scale = $derived(niceScale(Math.min(...all, 0), Math.max(...all, 0), 4, area));
  const count = $derived(Math.max(labels.length, ...series.map((s) => s.values.length), 1));
  const step = $derived(labelStep(labels, inner / Math.max(1, count - 1)));
  const drawn = $derived(
    series.map((s, index) => {
      const points = seriesPoints(s.values, scale, inner, PLOT - PAD * 2).map((point) => ({ x: point.x + PAD, y: point.y + PAD }));
      return { color: seriesColor(p, index), points, svg: seriesSvg(points, inner + PAD * 2, PLOT, { area, stroke: 2 }) };
    }),
  );
  const dots = $derived(count <= 16);
  const y = (value: number): number => PLOT - PAD * 2 - ((value - scale.lo) / Math.max(1e-9, scale.hi - scale.lo)) * (PLOT - PAD * 2) + PAD;
</script>

<View style={{ gap: 10 }}>
  <View style={{ width: chart, paddingTop: 8 }}>
    <View style={{ direction: "row" }}>
      <View style={{ width: AXIS, height: PLOT }}>
        {#each scale.ticks as tick}
          <Text style={{ position: "absolute", right: 8, top: y(tick) - 8, fontSize: 11, color: p.muted, lineHeight: 16, fontFamily: "mono" }}>{fmt(tick)}</Text>
        {/each}
      </View>
      <View style={{ width: plot, height: PLOT }}>
        {#each scale.ticks as tick}
          <View style={{ position: "absolute", left: 0, right: 0, top: y(tick), height: 1, background: p.border, opacity: 0.7 }} />
        {/each}
        <View style={{ position: "absolute", left: inset - PAD, top: 0, width: inner + PAD * 2, height: PLOT }}>
          {#each drawn as line}
            <Icon svg={line.svg} color={line.color} style={{ position: "absolute", left: 0, top: 0, width: inner + PAD * 2, height: PLOT }} />
            {#if dots}
              {#each line.points as point}
                <View style={{ position: "absolute", left: point.x - 3, top: point.y - 3, size: 6, radius: 3, background: line.color, borderWidth: 1.5, borderColor: p.surface }} />
              {/each}
            {/if}
          {/each}
        </View>
      </View>
    </View>
    <View style={{ height: 20, marginLeft: AXIS + inset, marginTop: 6 }}>
      {#each labels as label, index}
        {#if index % step === 0}
          <Text style={{ position: "absolute", left: (index / Math.max(1, count - 1)) * inner - 30, width: 60, textAlign: "center", color: p.muted, fontSize: 12, truncate: true }}>{label}</Text>
        {/if}
      {/each}
    </View>
  </View>
  {#if series.length > 1}
    <Legend items={series.map((s, index) => ({ label: s.name, color: seriesColor(p, index) }))} />
  {/if}
</View>
