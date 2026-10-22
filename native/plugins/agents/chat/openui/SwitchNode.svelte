<script lang="ts">
  // An on/off switch with its label; Space toggles it.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import Focus from "./Focus.svelte";
  import { str } from "./props";
  import Toggle from "./Toggle.svelte";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const on = $derived(doc.value(node) === true);
  const off = $derived(doc.streaming);
  $effect(() => doc.view.echoed(key, node.props["value"]));

  function toggle(): void {
    doc.input(node, !on);
  }
</script>

<Focus
  id={key}
  disabled={off}
  onpress={toggle}
  onkey={(event: KeyEvent) => {
    if (event.key === " " || event.key === "Enter") {
      toggle();
      event.preventDefault();
    }
  }}
  style={{ direction: "row", align: "center", gap: 10, alignSelf: "start", paddingY: 3, cursor: off ? undefined : "pointer", opacity: off ? 0.6 : undefined }}
>
  {#snippet children(focused)}
    <Toggle {on} {focused} />
    <Text style={{ color: p.fg }}>{str(node, "label") ?? ""}</Text>
  {/snippet}
</Focus>
