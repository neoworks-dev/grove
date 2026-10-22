<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import OpenImage from "./OpenImage.svelte";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;
  const box = $derived(Math.min(width, 520));
  const alt = $derived(str(node, "alt"));
</script>

<View style={{ gap: 4, alignSelf: "start" }}>
  <OpenImage src={str(node, "src") ?? ""} {alt} width={box} height={Math.round(box * 0.6)} />
  {#if alt}
    <Text style={{ color: p.muted, fontSize: 12 }}>{alt}</Text>
  {/if}
</View>
