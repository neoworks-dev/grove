<!-- The vim layer's mode and the keys it is waiting on, as a status bar entry. Empty with the standard keys. -->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { EditorService } from "./service";

  let { service }: { service: EditorService } = $props();

  const status = $derived(service.vimStatus());
  const visible = $derived(service.keymap() === "vim" && status.mode !== "" && service.active() !== null);

  /** The mode's colour: insert and replace stand out from normal, and visual has its own. */
  const color = $derived.by(() => {
    if (status.mode === "INSERT") {
      return "#4ade80";
    }
    if (status.mode === "REPLACE") {
      return "#f87171";
    }
    if (status.mode === "VISUAL" || status.mode === "V-LINE" || status.mode === "V-BLOCK") {
      return "#a78bfa";
    }
    return "#a1a1aa";
  });
</script>

{#if visible}
  <View style={{ direction: "row", gap: 8, align: "center" }}>
    <Text style={{ color, fontSize: 12, fontWeight: "bold" }}>{status.mode}</Text>
    {#if status.pending !== ""}
      <Text style={{ color: "#e4e4e7", fontSize: 12 }}>{status.pending}</Text>
    {/if}
  </View>
{/if}
