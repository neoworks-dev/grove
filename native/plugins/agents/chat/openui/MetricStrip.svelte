<script lang="ts">
  // Metrics side by side in one band, divided by thin rules, wrapping onto further lines.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { childPath } from "./paths";
  import { cellWidth, chunk, columnsFor, METRIC_MIN, type Placed } from "./layout";
  import Node from "./Node.svelte";

  interface Props {
    items: Placed[];
    width: number;
    path: string;
    prop?: string;
  }

  let { items, width, path, prop = "children" }: Props = $props();
  const p = neouiPalette;

  const columns = $derived(columnsFor(width - 2, items.length, METRIC_MIN, 0));
  const cell = $derived(cellWidth(width - 2, columns, 0));
  const rows = $derived(chunk(items, columns));
</script>

<View style={{ background: p.surface, radius: p.radius.m, borderWidth: 1, borderColor: p.border, overflow: "hidden" }}>
  {#each rows as row, line}
    <View style={{ direction: "row", borderTopWidth: line === 0 ? 0 : 1, borderColor: p.border }}>
      {#each row as at, column}
        <View style={{ width: cell, shrink: 0, padding: 14, borderLeftWidth: column === 0 ? 0 : 1, borderColor: p.border }}>
          <Node node={at.node} path={childPath(path, prop, at.index)} width={cell - 28} />
        </View>
      {/each}
    </View>
  {/each}
</View>
