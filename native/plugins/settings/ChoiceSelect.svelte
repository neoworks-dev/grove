<!--
  A dropdown over a list of choices. It is a `Popover` with a `Menu`, as the header's menus are,
  so the list can follow the theme, which svelte-gpui's own `Select` cannot.
-->
<script lang="ts">
  import { Button, Icon, Menu, Popover, Text } from "@neoworks/svelte-gpui/ui";
  import caretUpDown from "@phosphor-icons/core/regular/caret-up-down.svg";
  import HiddenLabel from "./HiddenLabel.svelte";
  import { colors, fontSize, menuItemStyle, overlayPanel, radius } from "../theme/tokens";

  interface Props {
    value: string;
    /** Names the button for the test harness (see `HiddenLabel`). */
    label?: string;
    options: { value: string; label: string }[];
    onchange: (value: string) => void;
  }

  let { value, label, options, onchange }: Props = $props();

  let open = $state(false);

  /** The label of the chosen option; the raw value when no option has it. */
  function labelOf(chosen: string): string {
    const found = options.find((option) => option.value === chosen);
    if (!found) {
      return chosen;
    }
    return found.label;
  }

  const rows = $derived(
    options.map((option) => ({
      label: option.label,
      value: option.value,
      checked: option.value === value,
      onselect: () => onchange(option.value),
    })),
  );
</script>

<Popover bind:open side="bottom" align="start" offset={4} focusPanel={false} matchWidth style={overlayPanel}>
  {#snippet trigger({ toggle })}
    <Button
      style={{
        width: 264,
        direction: "row",
        align: "center",
        gap: 8,
        paddingX: 10,
        paddingY: 6,
        radius: radius.md,
        fontSize: fontSize.xs,
        background: colors.input,
        borderWidth: 1,
        borderColor: open ? colors.accent : colors.line,
        color: colors.text,
      }}
      hover={{ borderColor: colors.accent }}
      onpress={toggle}
    >
      <Text style={{ flex: 1, minWidth: 0, truncate: true }}>{labelOf(value)}</Text>
      <Icon svg={caretUpDown} size={12} />
      {#if label}
        <HiddenLabel text={label} />
      {/if}
    </Button>
  {/snippet}
  {#snippet children({ close })}
    <Menu items={rows} onclose={() => close("select")} style={{ background: "transparent" }} itemStyle={menuItemStyle()} />
  {/snippet}
</Popover>
