<script lang="ts">
  // One choice out of a few: a ring for each option. Arrow keys choose.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import Focus from "./Focus.svelte";
  import { pick, textOf } from "./form";
  import Mark from "./Mark.svelte";
  import { choices, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const options = $derived(choices(node));
  const value = $derived(textOf(doc.value(node)));
  const error = $derived(str(node, "error") !== undefined);
  const off = $derived(doc.streaming);
  $effect(() => doc.view.echoed(key, node.props["value"]));

  function choose(to: string | undefined): void {
    if (to !== undefined && to !== value && !off) doc.input(node, to);
  }

  function onkey(event: KeyEvent): void {
    const by = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (by === undefined) return;
    choose(pick(options, value, by));
    event.preventDefault();
  }
</script>

<Focus id={key} disabled={off} {onkey} style={{ gap: 2, alignSelf: "start", opacity: off ? 0.6 : undefined }}>
  {#snippet children(focused)}
    {#each options as option}
      <View onpress={() => choose(option.value)} style={{ direction: "row", align: "center", gap: 10, paddingY: 3, cursor: off ? undefined : "pointer" }}>
        <Mark on={option.value === value} round focused={focused && option.value === value} {error} />
        <Text style={{ color: p.fg }}>{option.label}</Text>
      </View>
    {/each}
  {/snippet}
</Focus>
<FieldError {node} />
