<script lang="ts">
  // Suggested next questions as pills, side by side and wrapping. Choosing one sends its text to
  // the assistant, which comes with the doc's buttons: for now they are drawn and cannot be pressed.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
</script>

<View style={{ direction: "row", wrap: true, gap: 8 }}>
  {#each nodes(node, "items") as item}
    <View style={{ paddingX: 14, paddingY: 6, radius: 999, borderWidth: 1, borderColor: p.border, background: p.surface }}>
      <Text style={{ color: p.accent }}>{str(item, "text") ?? ""}</Text>
    </View>
  {/each}
</View>
