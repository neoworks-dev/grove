<!--
  The palette as the `overlay` slot draws it: nothing while closed, and while open a dimmed
  window with the card on it. Each time the palette opens the card is built afresh, so the query
  and the highlighted row start over.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import { colors } from "../theme/tokens";
  import PaletteCard from "./PaletteCard.svelte";
  import type { PaletteService } from "./service";

  let { palette }: { palette: PaletteService } = $props();

  const session = $derived(palette.session());
</script>

{#if session}
  {#key session}
    <View
      style={{ position: "absolute", inset: 0, align: "center", paddingTop: 80, background: colors.scrim }}
      onpress={() => palette.close()}
    >
      <PaletteCard {palette} {session} />
    </View>
  {/key}
{/if}
