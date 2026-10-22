<script lang="ts">
  // A button: primary on the accent colour, secondary with an outline, danger red. One with a link
  // carries an arrow and one that copies a copy icon. Pressing sends what the form holds, then the press.
  import { Button, Icon, Text } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import copy from "@phosphor-icons/core/regular/copy.svg";
  import arrow from "@phosphor-icons/core/regular/arrow-up-right.svg";
  import { buttonLook, neouiPalette } from "./look";
  import { useDoc } from "./context";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const off = $derived(doc.streaming || node.props["disabled"] === true);
  const look = $derived(buttonLook(p, str(node, "variant")));
  let element: { focus(): void; blur(): void } | undefined = $state();
  $effect(() => {
    if (key === "" || off) return;
    return doc.view.register(key, () => element?.focus());
  });
</script>

<Button
  bind:this={element}
  disabled={off}
  onpress={() => doc.press(node)}
  onfocus={() => (doc.view.focus = key)}
  onblur={() => {
    if (doc.view.focus === key) doc.view.focus = undefined;
  }}
  onkey={(event: KeyEvent) => {
    if (event.key === "Escape") {
      element?.blur();
      event.preventDefault();
      event.stopPropagation();
    }
  }}
  style={{ direction: "row", align: "center", gap: 6, alignSelf: "start", paddingX: 14, paddingY: 7, radius: p.radius.s, borderWidth: 1, borderColor: look.border, background: look.background, color: look.color, transition: 120 }}
  hover={{ background: look.hover }}
  active={{ opacity: 0.8 }}
  focus={{ borderColor: p.fg }}
  disabledStyle={{ opacity: 0.45 }}
>
  <Text style={{ fontWeight: "medium", color: look.color, nowrap: true }}>{str(node, "label") ?? ""}</Text>
  {#if typeof node.props["url"] === "string"}
    <Icon svg={arrow} size={14} />
  {:else if typeof node.props["copy"] === "string"}
    <Icon svg={copy} size={14} />
  {/if}
</Button>
