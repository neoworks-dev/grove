<script lang="ts">
  // The user's message on a band, behind a ›.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ViewItem } from "@suite/protocol/types";
  import { palette } from "../palette";
  import Component from "./Component.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import { GUTTER } from "./layout";

  let { item }: { item: ViewItem } = $props();

  const p = palette;
</script>

<ItemFrame>
  <View style={{ direction: "row", background: p.band, paddingX: p.space.l, paddingY: p.space.m }}>
    <Text style={{ width: GUTTER, color: p.accent, fontWeight: "bold" }}>›</Text>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Component component={item.component} ref={item.ref} />
    </View>
  </View>
</ItemFrame>
