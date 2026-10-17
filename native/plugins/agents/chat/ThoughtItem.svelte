<script lang="ts">
  // The agent's thoughts, muted and italic behind a ∴.
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
  <View style={{ direction: "row", paddingX: p.space.l, color: p.muted, italic: true }}>
    <Text style={{ width: GUTTER, italic: false }}>∴</Text>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Component component={item.component} ref={item.ref} />
    </View>
  </View>
</ItemFrame>
