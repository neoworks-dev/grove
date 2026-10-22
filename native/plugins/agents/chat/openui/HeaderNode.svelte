<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const subtitle = $derived(str(node, "subtitle"));
</script>

<View style={{ gap: 2 }}>
  <Text style={{ fontSize: p.text.title + 2, fontWeight: "semibold", lineHeight: 24 }}>{str(node, "title") ?? ""}</Text>
  {#if subtitle}
    <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{subtitle}</Text>
  {/if}
</View>
