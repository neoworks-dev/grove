<script lang="ts">
  // A sequence with each step's status: a check, a ring for the one under way, a plain ring, a cross.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import check from "@phosphor-icons/core/fill/check-circle-fill.svg";
  import circle from "@phosphor-icons/core/regular/circle.svg";
  import current from "@phosphor-icons/core/fill/circle-half-fill.svg";
  import cross from "@phosphor-icons/core/fill/x-circle-fill.svg";
  import { neouiPalette } from "./look";
  import { nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const steps = $derived(nodes(node, "steps"));

  function look(status: string | undefined): { icon: string; color: string } {
    switch (status) {
      case "done":
        return { icon: check, color: p.success };
      case "current":
        return { icon: current, color: p.accent };
      case "failed":
        return { icon: cross, color: p.danger };
      default:
        return { icon: circle, color: p.muted };
    }
  }
</script>

<View>
  {#each steps as step, index}
    {@const look_ = look(str(step, "status"))}
    <View style={{ direction: "row", gap: 10 }}>
      <View style={{ align: "center", width: 18 }}>
        <Icon svg={look_.icon} size={18} color={look_.color} />
        {#if index < steps.length - 1}
          <View style={{ width: 1.5, flex: 1, minHeight: 10, background: p.border, marginY: 2 }} />
        {/if}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: index < steps.length - 1 ? 10 : 0, gap: 1 }}>
        <Text style={{ fontWeight: "medium", color: str(step, "status") === "pending" ? p.muted : p.fg }}>{str(step, "title") ?? ""}</Text>
        {#if str(step, "detail")}
          <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{str(step, "detail")}</Text>
        {/if}
      </View>
    </View>
  {/each}
</View>
