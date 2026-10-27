<!--
  The messages sent while a turn runs, above the input: one muted row each, the first line of the
  message, the first row tagged "queued" with the key that takes them back. Ported from neo term's
  draw_waiting (apps/term).
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { WaitingInput } from "@suite/protocol/types";
  import { palette } from "./palette";
  import { queuedRows } from "./queued";

  interface Props {
    waiting: readonly WaitingInput[];
  }

  let { waiting }: Props = $props();

  const p = palette;
  const rows = $derived(queuedRows(waiting));
</script>

<View style={{ paddingX: p.space.m, gap: 2 }}>
  {#each rows.shown as row, index (index)}
    <View style={{ direction: "row", gap: p.space.m }}>
      <Text style={{ color: p.muted, flex: 1, minWidth: 0, truncate: true }}>◷ {row}</Text>
      {#if index === 0}
        <Text style={{ color: p.accent, shrink: 0 }}>queued</Text>
        <Text style={{ color: p.muted, shrink: 0 }}>↑ edits</Text>
      {/if}
    </View>
  {/each}
  {#if rows.hidden > 0}
    <Text style={{ color: p.muted }}>… +{rows.hidden} more queued</Text>
  {/if}
</View>
