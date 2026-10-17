<!--
  The hint for a half-typed key sequence: the keys that can come next and what each does, in a
  card at the bottom of the window. It shows only while a sequence is pending, and `+` marks a key
  that opens a further level.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeymapService } from "../../kernel/keymap";
  import { colors, fontSize, overlayPanel, radius } from "../theme/tokens";

  let { keymap }: { keymap: KeymapService } = $props();

  const nextKeys = $derived(keymap.nextKeys());
</script>

{#if nextKeys.length > 0}
  <View style={{ position: "absolute", left: 0, right: 0, bottom: 40, align: "center" }}>
    <View style={{ ...overlayPanel, direction: "row", wrap: true, gap: 6, padding: 10, maxWidth: "80%" }}>
      {#each nextKeys as next (next.key)}
        <View style={{ direction: "row", align: "center", gap: 8, width: 190, paddingX: 6, paddingY: 3 }}>
          <Text
            style={{
              paddingX: 6,
              paddingY: 1,
              radius: radius.sm,
              background: colors.lineFaint,
              color: colors.accent,
              fontFamily: "mono",
              fontSize: fontSize.xs,
            }}>{next.key}</Text
          >
          <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xs, color: colors.muted }}>
            {next.continues ? "+more" : next.description}
          </Text>
        </View>
      {/each}
    </View>
  </View>
{/if}
