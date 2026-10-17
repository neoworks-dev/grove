<!--
  A small dropdown for the row under the composer: a button with the chosen option, and a list
  above it, since the composer sits at the bottom of the pane.
-->
<script lang="ts">
  import { Button, Icon, Menu, Popover, Text } from "@neoworks/svelte-gpui/ui";
  import caretDown from "@phosphor-icons/core/regular/caret-down.svg";
  import { menuItemStyle, overlayPanel } from "../theme/tokens";
  import { palette } from "./palette";

  interface Props {
    value: string;
    options: { value: string; label: string }[];
    onchange: (value: string) => void;
  }

  let { value, options, onchange }: Props = $props();

  const p = palette;
  let open = $state(false);

  const shown = $derived(options.find((option) => option.value === value)?.label ?? value);
  const rows = $derived(
    options.map((option) => ({
      label: option.label,
      value: option.value,
      checked: option.value === value,
      onselect: () => onchange(option.value),
    })),
  );
</script>

<Popover bind:open side="top" align="start" offset={4} focusPanel={false} style={overlayPanel}>
  {#snippet trigger({ toggle })}
    <Button
      onpress={toggle}
      style={{
        direction: "row",
        align: "center",
        gap: p.space.s,
        paddingX: p.space.m,
        height: 22,
        radius: 4,
        borderWidth: 1,
        borderColor: open ? p.accent : p.border,
        color: p.fg,
      }}
      hover={{ borderColor: p.accent }}
    >
      <Text style={{ fontSize: p.text.code }}>{shown}</Text>
      <Icon svg={caretDown} size={10} />
    </Button>
  {/snippet}
  {#snippet children({ close })}
    <Menu items={rows} onclose={() => close("select")} style={{ background: "transparent" }} itemStyle={menuItemStyle()} />
  {/snippet}
</Popover>
