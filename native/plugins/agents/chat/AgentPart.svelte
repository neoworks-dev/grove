<script lang="ts">
  // Markdown of the agent's reply behind a bullet, under the name of the guest it is from, if any. A
  // long reply is drawn as one of these per block, each a row of the chat's list: the first has the
  // name and the bullet, the ones after it line up under the first, and the last has the room below
  // the item. The space above a part is the item's own at the first, and the gap between two blocks
  // of markdown at the others, which is the same.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { TextComponent, ViewItem } from "@suite/protocol/types";
  import { palette } from "../palette";
  import Component from "./Component.svelte";
  import { GUTTER } from "./layout";

  interface Props {
    item: ViewItem;
    /** The text to draw: the whole reply, or one block of it. */
    component: TextComponent;
    first: boolean;
    last: boolean;
  }

  let { item, component, first, last }: Props = $props();

  const p = palette;
</script>

<View style={{ paddingTop: p.space.m, paddingBottom: last ? p.space.s : 0, paddingX: p.space.l, gap: p.space.s }}>
  {#if first && item.label}
    <Text style={{ color: p.accent, fontWeight: "bold" }}>{item.label}</Text>
  {/if}
  <View style={{ direction: "row" }}>
    {#if first}
      <Text style={{ width: GUTTER }}>●</Text>
    {:else}
      <View style={{ width: GUTTER }} />
    {/if}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Component {component} ref={item.ref} />
    </View>
  </View>
</View>
