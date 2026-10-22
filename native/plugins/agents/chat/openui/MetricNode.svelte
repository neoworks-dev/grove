<script lang="ts">
  // A headline number: the value large, its change after it in the tone's colour, the label muted
  // under them.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { toneColor } from "./look";
  import { str, tone as toneOf } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const delta = $derived(str(node, "delta"));
</script>

<View style={{ gap: 2 }}>
  <View style={{ direction: "row", align: "baseline", gap: 8, wrap: true }}>
    <Text style={{ fontSize: 24, lineHeight: 30, fontWeight: "semibold" }}>{str(node, "value") ?? ""}</Text>
    {#if delta}
      <Text style={{ color: toneColor(toneOf(node) ?? "muted", p), fontSize: p.text.body - 1, fontWeight: "medium" }}>{delta}</Text>
    {/if}
  </View>
  <Text style={{ color: p.muted, fontSize: 12 }}>{str(node, "label") ?? ""}</Text>
</View>
