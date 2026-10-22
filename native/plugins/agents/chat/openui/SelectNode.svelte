<script lang="ts">
  // A dropdown: a button with the chosen option that opens a list under it. Left and Right pick the
  // previous and next option without opening it, Down or Enter open it.
  import { Button, Icon, Menu, Popover, Text } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent, MenuItem } from "@neoworks/svelte-gpui/ui";
  import caret from "@phosphor-icons/core/regular/caret-down.svg";
  import { fieldLook, neouiPalette } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import { pick, textOf } from "./form";
  import { choices, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const options = $derived(choices(node));
  const value = $derived(textOf(doc.value(node)));
  const chosen = $derived(options.findIndex((option) => option.value === value));
  const error = $derived(str(node, "error") !== undefined);
  const off = $derived(doc.streaming);
  const items: MenuItem[] = $derived(
    options.map((option, index) => ({ label: option.label, value: option.value, checked: index === chosen })),
  );

  let open = $state(false);
  let focused = $state(false);
  let element: { focus(): void; blur(): void } | undefined = $state();
  $effect(() => doc.view.echoed(key, node.props["value"]));
  $effect(() => doc.view.register(key, () => element?.focus()));

  function choose(to: string | undefined): void {
    if (to !== undefined && to !== value) doc.input(node, to);
  }

  function onkey(event: KeyEvent, show: () => void): void {
    if (event.key === "Escape" && !open) {
      element?.blur();
      event.preventDefault();
      event.stopPropagation();
    } else if (open) {
      return;
    } else if (event.key === "ArrowLeft") {
      choose(pick(options, value, -1));
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      choose(pick(options, value, 1));
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      show();
      event.preventDefault();
    }
  }
</script>

<Popover
  bind:open
  side="bottom"
  align="start"
  offset={4}
  matchWidth
  focusPanel={false}
  anchorStyle={{ alignSelf: "stretch", maxWidth: 360 }}
  style={{ padding: 2, background: p.surface, radius: p.radius.s, borderWidth: 1, borderColor: p.border, shadow: { y: 8, blur: 24, color: "rgba(0, 0, 0, 0.5)" } }}
>
  {#snippet trigger({ toggle, show })}
    <Button
      bind:this={element}
      disabled={off}
      onpress={toggle}
      onkey={(event: KeyEvent) => onkey(event, show)}
      onfocus={() => {
        focused = true;
        doc.view.focus = key;
      }}
      onblur={() => {
        focused = false;
        if (doc.view.focus === key) doc.view.focus = undefined;
      }}
      style={{ ...fieldLook(p, { focused: focused || open, error }), direction: "row", align: "center", gap: 8, paddingX: 12, paddingY: 8, color: p.fg, opacity: off ? 0.6 : undefined }}
      hover={{ borderColor: error ? p.danger : p.muted }}
    >
      <Text style={{ flex: 1, minWidth: 0, truncate: true, color: chosen < 0 ? p.muted : p.fg }}>
        {chosen < 0 ? (str(node, "placeholder") ?? "Select") : (options[chosen]?.label ?? "")}
      </Text>
      <Icon svg={caret} size={14} color={p.muted} />
    </Button>
  {/snippet}
  {#snippet children({ close })}
    <Menu
      {items}
      initial={chosen >= 0 ? chosen : undefined}
      maxHeight={240}
      onselect={(item: MenuItem) => choose(typeof item.value === "string" ? item.value : undefined)}
      onclose={() => close("select")}
      itemStyle={{ radius: 6, paddingX: 10 }}
    />
  {/snippet}
</Popover>
<FieldError {node} />
