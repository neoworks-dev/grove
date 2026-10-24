<!--
  A small dropdown for the composer's footer: the chosen option as quiet text, and a list above
  it, since the composer sits at the bottom of the pane.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button, Icon, Menu, Popover, Text } from "@neoworks/svelte-gpui/ui";
  import caretDown from "@phosphor-icons/core/regular/caret-down.svg";
  import { menuItemStyle, overlayPanel } from "../theme/tokens";
  import { palette } from "./palette";
  import SearchList from "./SearchList.svelte";

  interface Props {
    value: string;
    /** `icon` is SVG markup drawn in front of an option's label. */
    options: { value: string; label: string; icon?: string }[];
    /** What the button says, when it is not the chosen option's label. */
    shown?: string;
    /** Drawn in front of the label, such as the harness's logo. */
    icon?: Snippet;
    /** Runs when the list opens, as to ask the daemon for the choices. */
    onopen?: () => void;
    onchange: (value: string) => void;
    /** The list's width in pixels, for options with long labels; it fits its content otherwise. */
    width?: number;
  }

  let { value, options, shown, icon, onopen, onchange, width }: Props = $props();

  const p = palette;
  /** Past this many options the list gets a search field and builds only the rows in view. */
  const LONG_LIST = 20;
  let open = $state(false);

  // The choices can change while the list is closed, so they are asked for each time it opens.
  $effect(() => {
    if (open && onopen !== undefined) {
      onopen();
    }
  });

  const label = $derived(shown ?? options.find((option) => option.value === value)?.label ?? value);
  const rows = $derived(
    options.map((option) => ({
      label: option.label,
      value: option.value,
      icon: option.icon,
      checked: option.value === value,
      onselect: () => onchange(option.value),
    })),
  );
</script>

<Popover bind:open side="top" align="start" offset={4} focusPanel={false} style={width === undefined ? overlayPanel : { ...overlayPanel, width }}>
  {#snippet trigger({ toggle })}
    <Button
      onpress={toggle}
      style={{
        direction: "row",
        align: "center",
        gap: p.space.s,
        paddingX: p.space.s,
        height: 22,
        radius: 4,
        color: open ? p.fg : p.muted,
        background: open ? p.band : "transparent",
      }}
      hover={{ color: p.fg, background: p.band }}
    >
      {#if icon !== undefined}
        {@render icon()}
      {/if}
      <Text style={{ fontSize: p.text.code, nowrap: true }}>{label}</Text>
      <Icon svg={caretDown} size={10} />
    </Button>
  {/snippet}
  {#snippet children({ close })}
    {#if options.length > LONG_LIST}
      <SearchList
        {value}
        {options}
        onpick={(picked) => {
          onchange(picked);
          close("select");
        }}
      />
    {:else}
      <Menu items={rows} onclose={() => close("select")} style={{ background: "transparent" }} itemStyle={menuItemStyle()} />
    {/if}
  {/snippet}
</Popover>
