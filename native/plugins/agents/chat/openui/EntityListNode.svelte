<script lang="ts">
  // One row per thing: the title bold, the subtitle muted, the value or tag at the end. When the
  // row does not fit, the subtitle goes under its title.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { childPath } from "./paths";
  import { entityStacked } from "./layout";
  import Node from "./Node.svelte";
  import { cellOf, nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;

  const items = $derived(
    nodes(node, "items").map((item) => ({
      title: str(item, "title") ?? "",
      subtitle: str(item, "subtitle"),
      trailing: item.props["trailing"] === undefined ? undefined : cellOf(item.props["trailing"]),
    })),
  );
  const stacked = $derived(entityStacked(items, width - 2));
</script>

{#snippet trailing(value: (typeof items)[number]["trailing"], index: number)}
  {#if typeof value === "string"}
    <Text style={{ color: p.muted, nowrap: true }}>{value}</Text>
  {:else if value !== undefined}
    <Node node={value} path={childPath(path, `items.${index}/trailing`, 0)} width={120} />
  {/if}
{/snippet}

<View style={{ borderWidth: 1, borderColor: p.border, radius: p.radius.s, overflow: "hidden" }}>
  {#each items as item, index}
    <View style={{ borderTopWidth: index === 0 ? 0 : 1, borderColor: p.border, paddingX: 12, paddingY: 9 }}>
      {#if stacked}
        <View style={{ direction: "row", align: "center", gap: 10 }}>
          <Text style={{ flex: 1, minWidth: 0, fontWeight: "medium" }}>{item.title}</Text>
          {@render trailing(item.trailing, index)}
        </View>
        {#if item.subtitle}
          <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{item.subtitle}</Text>
        {/if}
      {:else}
        <View style={{ direction: "row", align: "center", gap: 12 }}>
          <Text style={{ fontWeight: "medium", shrink: 0 }}>{item.title}</Text>
          <Text style={{ flex: 1, minWidth: 0, color: p.muted, truncate: true }}>{item.subtitle ?? ""}</Text>
          {@render trailing(item.trailing, index)}
        </View>
      {/if}
    </View>
  {/each}
</View>
