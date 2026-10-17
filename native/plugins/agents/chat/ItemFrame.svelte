<script lang="ts">
  // The room around one chat item, whatever it is.
  import type { Snippet } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import { palette } from "../palette";

  let { children }: { children: Snippet } = $props();

  const p = palette;
</script>

<View style={{ paddingTop: p.space.m, paddingBottom: p.space.s }}>
  {@render children()}
</View>
