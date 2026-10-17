<!--
  The bottom status bar. Items are self-contained components pinned left or right and ordered
  within their side; each gets its own props, as the registry in `lib/statusbar.svelte.ts`
  carried them.
-->
<script module lang="ts">
  import type { Component } from "svelte";

  export interface StatusItem {
    id: string;
    order: number;
    align: "left" | "right";
    component: Component<any>;
    props?: Record<string, unknown>;
  }
</script>

<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, size } from "../theme/tokens";

  interface Props {
    items: StatusItem[];
    /** An item threw while drawing. It is replaced by a short notice and the rest keep drawing. */
    onerror?: (itemId: string, error: unknown) => void;
  }

  let { items, onerror }: Props = $props();

  /** The items of one side, in order. */
  function sideItems(align: "left" | "right"): StatusItem[] {
    return items.filter((item) => item.align === align).sort((first, second) => first.order - second.order);
  }

  const leftItems = $derived(sideItems("left"));
  const rightItems = $derived(sideItems("right"));
</script>

<View
  style={{
    direction: "row",
    align: "center",
    justify: "between",
    height: size.statusBarHeight,
    shrink: 0,
    paddingX: 4,
    color: colors.muted,
    fontSize: fontSize.xxs,
  }}
>
  <View style={{ direction: "row", align: "center", gap: 12 }}>
    {#each leftItems as item (item.id)}
      <svelte:boundary onerror={(error) => onerror?.(item.id, error)}>
        <item.component {...item.props} />
        {#snippet failed()}
          <Text style={{ color: colors.red }}>{item.id} failed</Text>
        {/snippet}
      </svelte:boundary>
    {/each}
  </View>
  <View style={{ direction: "row", align: "center", gap: 12 }}>
    {#each rightItems as item (item.id)}
      <svelte:boundary onerror={(error) => onerror?.(item.id, error)}>
        <item.component {...item.props} />
        {#snippet failed()}
          <Text style={{ color: colors.red }}>{item.id} failed</Text>
        {/snippet}
      </svelte:boundary>
    {/each}
  </View>
</View>
