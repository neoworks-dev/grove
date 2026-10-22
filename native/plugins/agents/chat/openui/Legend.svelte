<script lang="ts">
  // What the colours of a chart stand for: a small square and the name, side by side.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";

  let { items }: { items: { label: string; color: string; note?: string }[] } = $props();
  const p = neouiPalette;
</script>

<View style={{ direction: "row", wrap: true, columnGap: 14, rowGap: 4 }}>
  {#each items as item}
    <View style={{ direction: "row", align: "center", gap: 6 }}>
      <View style={{ size: 9, radius: 2, background: item.color }} />
      <Text style={{ color: p.muted, fontSize: 12 }}>{item.label}{item.note ? `  ${item.note}` : ""}</Text>
    </View>
  {/each}
</View>
