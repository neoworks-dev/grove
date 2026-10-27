<script lang="ts">
  // The agent's reply: markdown behind a bullet, anything else as it is, under the name of the guest
  // it is from, if any.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ViewItem } from "@suite/protocol/types";
  import { palette } from "../palette";
  import AgentPart from "./AgentPart.svelte";
  import Component from "./Component.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import { PREVIEW_LINES } from "./layout";
  import { chatView } from "./viewState";

  let { item }: { item: ViewItem } = $props();

  const p = palette;
</script>

{#if item.component.type === "text"}
  <AgentPart {item} component={item.component} first last />
{:else}
  <ItemFrame>
    <View style={{ paddingX: p.space.l, gap: p.space.s }}>
      {#if item.label}
        <Text style={{ color: p.accent, fontWeight: "bold" }}>{item.label}</Text>
      {/if}
      <Component component={item.component} ref={item.ref} limit={chatView.expanded ? undefined : PREVIEW_LINES} />
    </View>
  </ItemFrame>
{/if}
