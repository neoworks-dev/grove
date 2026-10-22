<script lang="ts">
  // A value with its change inline: `1284 ▲ 12% vs last week`. Up is success and down danger unless
  // the node says a tone.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import down from "@phosphor-icons/core/fill/caret-down-fill.svg";
  import up from "@phosphor-icons/core/fill/caret-up-fill.svg";
  import { neouiPalette } from "./look";
  import { toneColor } from "./look";
  import { str, tone as toneOf } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;

  const direction = $derived(str(node, "direction"));
  const delta = $derived(str(node, "delta"));
  const color = $derived.by(() => {
    const tone = toneOf(node);
    if (tone !== undefined) return toneColor(tone, p);
    if (direction === "up") return p.success;
    return direction === "down" ? p.danger : p.muted;
  });
  const subtext = $derived(str(node, "subtext"));
</script>

<View style={{ direction: "row", align: "center", gap: 6, wrap: true, alignSelf: "start" }}>
  <Text style={{ fontWeight: "semibold" }}>{str(node, "value") ?? ""}</Text>
  {#if delta || direction}
    <View style={{ direction: "row", align: "center", gap: 3, color }}>
      {#if direction === "up" || direction === "down"}
        <Icon svg={direction === "up" ? up : down} size={11} />
      {/if}
      {#if delta}<Text style={{ fontWeight: "medium", fontSize: p.text.body - 1 }}>{delta}</Text>{/if}
    </View>
  {/if}
  {#if subtext}
    <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{subtext}</Text>
  {/if}
</View>
