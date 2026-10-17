<script lang="ts">
  // The agent's reply behind a bullet, under the name of the guest it is from, if any.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ViewItem } from "@suite/protocol/types";
  import { palette } from "../palette";
  import Component from "./Component.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import { GUTTER, PREVIEW_LINES } from "./layout";
  import { chatView } from "./viewState";

  let { item }: { item: ViewItem } = $props();

  const p = palette;
</script>

<ItemFrame>
  <View style={{ paddingX: p.space.l, gap: p.space.s }}>
    {#if item.label}
      <Text style={{ color: p.accent, fontWeight: "bold" }}>{item.label}</Text>
    {/if}
    {#if item.component.type === "text"}
      <View style={{ direction: "row" }}>
        <Text style={{ width: GUTTER }}>●</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Component component={item.component} ref={item.ref} />
        </View>
      </View>
    {:else}
      <Component component={item.component} ref={item.ref} limit={chatView.expanded ? undefined : PREVIEW_LINES} />
    {/if}
  </View>
</ItemFrame>
