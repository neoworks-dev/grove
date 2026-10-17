<!--
  The language servers in the status bar: one entry for each, with a dot that says how it is
  doing. A server that is down can be pressed to start it again. Nothing shows while no server
  runs, as in a folder of files none serves.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, radius } from "../theme/tokens";
  import type { LspService } from "./service";
  import type { StatusTone } from "./servers";

  let { service }: { service: LspService } = $props();

  const entries = $derived(service.entries());

  /** The colour of a status dot. */
  function toneColor(tone: StatusTone): string {
    if (tone === "good") {
      return colors.green;
    }
    if (tone === "busy") {
      return colors.amber;
    }
    if (tone === "bad") {
      return colors.red;
    }
    return colors.dim;
  }
</script>

{#if entries.length > 0}
  <View style={{ direction: "row", align: "center", gap: 8 }}>
    {#each entries as entry (entry.id)}
      <Button
        style={{ paddingX: 4, radius: radius.sm, transition: 120, direction: "row", align: "center", gap: 5 }}
        hover={{ background: colors.hover, color: colors.text }}
        onpress={() => {
          if (entry.restartable) {
            void service.restart(entry.id);
          }
        }}
      >
        <View style={{ width: 7, height: 7, radius: 4, background: toneColor(entry.tone) }} />
        <Text>{entry.text}</Text>
      </Button>
    {/each}
  </View>
{/if}
