<script lang="ts">
  // The calls of a run or a folded turn, counted by tool: `read util.ts  shell ×2`.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { palette } from "../palette";
  import type { Tally } from "./turns";

  let { tallies }: { tallies: readonly Tally[] } = $props();

  const p = palette;
</script>

{#each tallies as tally (tally.name)}
  <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, shrink: 0 }}>
    {tally.name}{tally.count > 1 ? ` ×${tally.count}` : ""}
  </Text>
  {#if tally.files.length > 0}
    <View style={{ direction: "row", gap: p.space.m, shrink: 1, minWidth: 0, overflow: "hidden" }}>
      {#each tally.files as file (file)}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, truncate: true }}>{file}</Text>
      {/each}
    </View>
  {/if}
{/each}
