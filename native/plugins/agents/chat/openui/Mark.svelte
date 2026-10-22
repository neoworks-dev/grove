<script lang="ts">
  // The mark of a choice: a ring with a dot (a radio), or a square with a tick (a checkbox).
  import { Icon, View } from "@neoworks/svelte-gpui/ui";
  import tick from "@phosphor-icons/core/bold/check-bold.svg";
  import { neouiPalette } from "./look";

  interface Props {
    on: boolean;
    round?: boolean;
    focused?: boolean;
    error?: boolean;
  }

  let { on, round = false, focused = false, error = false }: Props = $props();
  const p = neouiPalette;
  const edge = $derived.by(() => {
    if (error) return p.danger;
    return on || focused ? p.accent : p.muted;
  });
</script>

<View
  style={{
    size: 18,
    shrink: 0,
    align: "center",
    justify: "center",
    radius: round ? 9 : 5,
    borderWidth: 1.5,
    borderColor: edge,
    background: on && !round ? p.accent : p.bg,
    color: p.bg,
  }}
>
  {#if on && round}
    <View style={{ size: 8, radius: 4, background: p.accent }} />
  {:else if on}
    <Icon svg={tick} size={12} />
  {/if}
</View>
