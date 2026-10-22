<script lang="ts">
  // A table: a header on the surface colour, rows divided by thin rules, number columns on the
  // right. A cell may be a Tag, a Link or a metric indicator. Columns share the width by their content.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { numericColumns, tableWeights } from "./content";
  import { childPath } from "./paths";
  import Node from "./Node.svelte";
  import { rows as rowsOf, strings } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;

  const columns = $derived(strings(node, "columns"));
  const rows = $derived(rowsOf(node));
  const weights = $derived(tableWeights(columns, rows));
  const numeric = $derived(numericColumns(weights.length, rows));
  const total = $derived(weights.reduce((sum, weight) => sum + weight, 0));
  const cellWidth = (column: number): number =>
    Math.max(40, Math.floor(((width - 2) * (weights[column] ?? 1)) / Math.max(1, total)) - 24);
</script>

<View style={{ borderWidth: 1, borderColor: p.border, radius: p.radius.s, overflow: "hidden" }}>
  <View style={{ direction: "row", background: p.raised, paddingY: 8 }}>
    {#each weights as weight, column}
      <View style={{ flex: weight, minWidth: 0, paddingX: 12 }}>
        <Text style={{ fontWeight: "semibold", fontSize: p.text.body - 1, color: p.muted, textAlign: numeric[column] ? "right" : "left" }}>{columns[column] ?? ""}</Text>
      </View>
    {/each}
  </View>
  {#each rows as row, index}
    <View style={{ direction: "row", paddingY: 8, borderTopWidth: 1, borderColor: p.border, align: "center" }}>
      {#each weights as weight, column}
        {@const cell = row[column] ?? ""}
        <View style={{ flex: weight, minWidth: 0, paddingX: 12, align: numeric[column] ? "end" : "start" }}>
          {#if typeof cell === "string"}
            <Text style={{ textAlign: numeric[column] ? "right" : "left" }}>{cell}</Text>
          {:else}
            <Node node={cell} path={childPath(path, `rows.${index}`, column)} width={cellWidth(column)} />
          {/if}
        </View>
      {/each}
    </View>
  {/each}
</View>
