<script lang="ts">
  // Bars per label, one colour per series, side by side or stacked, standing up or lying down.
  // Standing bars need room for their labels: when they do not fit the bars lie down, as in the
  // terminal. Pressing nothing here: hovering a group says its values.
  import { Text, Tooltip, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { barLayout, groupTip } from "./bars";
  import { fmt, heightOf, niceScale, seriesColor } from "./charts";
  import Legend from "./Legend.svelte";
  import { bool, nodes, numbers, str, strings } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;

  const labels = $derived(strings(node, "labels"));
  const series = $derived(
    nodes(node, "series").map((s) => ({ name: str(s, "name") ?? "", values: numbers(s, "values") })),
  );
  const stacked = $derived(bool(node, "stacked") === true);
  const chart = $derived(Math.min(width, 640));
  const layout = $derived(barLayout(labels, series, stacked, bool(node, "horizontal") === true, chart));
  const scale = $derived(niceScale(layout.min, layout.max, 4, true));
  const colors = $derived(series.map((_, index) => seriesColor(p, index)));
  const PLOT = 170;
  const AXIS = 44;
  const plot = $derived(chart - AXIS - 4);
  const slot = $derived(plot / Math.max(1, labels.length));
  const barWidth = $derived(layout.bar(slot));
  const labelWidth = $derived(Math.min(layout.labelWidth, Math.floor(chart * 0.35)));
  const valueWidth = $derived(series.length > 1 && !stacked ? 100 : 50);
  const trackWidth = $derived(Math.max(30, chart - labelWidth - valueWidth - 20));
</script>

<View style={{ gap: 10 }}>
  {#if layout.horizontal}
    <View style={{ gap: 8, width: chart }}>
      {#each labels as label, index}
        <View style={{ direction: "row", align: "center", gap: 10 }}>
          <Text style={{ width: labelWidth, shrink: 0, color: p.muted, fontSize: 12, truncate: true, textAlign: "right" }}>{label}</Text>
          <View style={{ width: trackWidth, gap: 3 }}>
            {#if stacked}
              <View style={{ direction: "row", height: 14, radius: 3, overflow: "hidden" }}>
                {#each series as s, at}
                  <View style={{ width: Math.max(0, heightOf(s.values[index] ?? 0, scale, trackWidth) - heightOf(0, scale, trackWidth)), background: colors[at] }} />
                {/each}
              </View>
            {:else}
              {#each series as s, at}
                <View style={{ width: Math.max(2, heightOf(s.values[index] ?? 0, scale, trackWidth) - heightOf(0, scale, trackWidth)), height: series.length > 1 ? 10 : 14, radius: [0, 3, 3, 0], background: colors[at] }} />
              {/each}
            {/if}
          </View>
          <Text style={{ color: p.fg, fontSize: 12, fontFamily: "mono", nowrap: true, width: valueWidth, shrink: 0 }}>{stacked ? fmt(series.reduce((sum, s) => sum + (s.values[index] ?? 0), 0)) : series.map((s) => fmt(s.values[index] ?? 0)).join(" / ")}</Text>
        </View>
      {/each}
    </View>
  {:else}
    <View style={{ width: chart, paddingTop: 12 }}>
      <View style={{ direction: "row" }}>
        <View style={{ width: AXIS, height: PLOT }}>
          {#each scale.ticks as tick}
            <Text style={{ position: "absolute", right: 8, top: PLOT - heightOf(tick, scale, PLOT) - 8, fontSize: 11, color: p.muted, lineHeight: 16, fontFamily: "mono" }}>{fmt(tick)}</Text>
          {/each}
        </View>
        <View style={{ width: plot, height: PLOT }}>
          {#each scale.ticks as tick}
            <View style={{ position: "absolute", left: 0, right: 0, top: PLOT - heightOf(tick, scale, PLOT), height: 1, background: tick === 0 ? p.muted : p.border, opacity: tick === 0 ? 0.6 : 0.7 }} />
          {/each}
          <View style={{ direction: "row", height: PLOT }}>
            {#each labels as label, index}
              <Tooltip content={tip} anchorStyle={{ width: slot, height: PLOT }}>
                <View style={{ width: slot, height: PLOT, direction: "row", align: "end", justify: "center", gap: 3 }}>
                  {#if stacked}
                    <View style={{ width: barWidth, justify: "end", height: PLOT }}>
                      {#each [...series].reverse() as s, from}
                        {@const at = series.length - 1 - from}
                        <View style={{ height: Math.max(0, heightOf(s.values[index] ?? 0, scale, PLOT) - heightOf(0, scale, PLOT)), background: colors[at], radius: at === series.length - 1 ? [3, 3, 0, 0] : 0 }} />
                      {/each}
                    </View>
                  {:else}
                    {#each series as s, at}
                      <View style={{ width: barWidth, align: "center" }}>
                        {#if barWidth >= 24}
                          <Text style={{ fontSize: 10, color: p.muted, lineHeight: 14 }}>{fmt(s.values[index] ?? 0)}</Text>
                        {/if}
                        <View style={{ width: barWidth, height: Math.max(1, heightOf(s.values[index] ?? 0, scale, PLOT) - heightOf(0, scale, PLOT)), background: colors[at], radius: [3, 3, 0, 0] }} />
                      </View>
                    {/each}
                  {/if}
                </View>
              </Tooltip>
              {#snippet tip()}
                <Text style={{ fontSize: 12 }}>{groupTip(label, series, index)}</Text>
              {/snippet}
            {/each}
          </View>
        </View>
      </View>
      <View style={{ direction: "row", paddingLeft: AXIS, paddingTop: 6 }}>
        {#each labels as label}
          <Text style={{ width: slot, textAlign: "center", color: p.muted, fontSize: 12, truncate: true }}>{label}</Text>
        {/each}
      </View>
    </View>
  {/if}
  {#if series.length > 1}
    <Legend items={series.map((s, index) => ({ label: s.name, color: colors[index] ?? p.accent }))} />
  {/if}
</View>
