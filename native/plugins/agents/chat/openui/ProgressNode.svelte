<script lang="ts">
  // A bar with its percentage. A label that says the percentage already is not repeated.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { progressLabel } from "./content";
  import { num, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;
  const value = $derived(Math.min(1, Math.max(0, num(node, "value") ?? 0)));
  const label = $derived(progressLabel(value, str(node, "label")));
</script>

<View style={{ direction: "row", align: "center", gap: 10 }}>
  <View style={{ width: Math.max(80, Math.min(280, width - 110)), height: 8, radius: 4, background: p.raised, overflow: "hidden" }}>
    <View style={{ width: `${Math.round(value * 100)}%`, height: 8, radius: 4, background: p.accent }} />
  </View>
  <Text style={{ color: p.muted, fontSize: p.text.body - 1, nowrap: true }}>{label}</Text>
</View>
