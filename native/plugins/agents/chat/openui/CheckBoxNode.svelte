<script lang="ts">
  // A checkbox with its label; Space toggles it.
  import { Text } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import Focus from "./Focus.svelte";
  import Mark from "./Mark.svelte";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const on = $derived(doc.value(node) === true);
  const error = $derived(str(node, "error") !== undefined);
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
    <Mark {on} {focused} {error} />
    <Text style={{ color: p.fg }}>{str(node, "label") ?? ""}</Text>
  {/snippet}
</Focus>
<FieldError {node} />
