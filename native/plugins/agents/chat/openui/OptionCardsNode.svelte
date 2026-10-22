<script lang="ts">
  // One choice out of a few, each a small card with a title and what it means; the chosen one has
  // the accent frame. Arrow keys choose, like a radio group.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette, tint } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import Focus from "./Focus.svelte";
  import { pick, textOf } from "./form";
  import { cardsPerRow } from "./layout";
  import { cellWidth, chunk } from "./layout";
  import Mark from "./Mark.svelte";
  import { choices, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const options = $derived(choices(node));
  const value = $derived(textOf(doc.value(node)));
  const error = $derived(str(node, "error") !== undefined);
  const off = $derived(doc.streaming);
  const gap = 10;
  const columns = $derived(cardsPerRow(width, options.length));
  const cell = $derived(cellWidth(width, columns, gap));
  const rows = $derived(chunk(options, columns));
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

<Focus id={key} disabled={off} {onkey} style={{ gap, opacity: off ? 0.6 : undefined }}>
  {#snippet children(focused)}
    {#each rows as row}
      <View style={{ direction: "row", gap, align: "stretch" }}>
        {#each row as option}
          {@const chosen = option.value === value}
          <View
            onpress={() => choose(option.value)}
            hover={{ borderColor: chosen ? p.accent : p.muted }}
            style={{
              width: cell,
              padding: 12,
              gap: 4,
              radius: p.radius.s,
              borderWidth: chosen ? 1.5 : 1,
              borderColor: error ? p.danger : chosen ? p.accent : p.border,
              background: chosen ? tint(p, p.accent, focused ? 22 : 12) : p.bg,
              cursor: off ? undefined : "pointer",
            }}
          >
            <View style={{ direction: "row", align: "center", gap: 8 }}>
              <Mark on={chosen} round {error} />
              <Text style={{ flex: 1, minWidth: 0, fontWeight: "medium" }}>{option.label}</Text>
            </View>
            {#if option.description}
              <View style={{ paddingLeft: 26, width: cell - 24 }}><Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{option.description}</Text></View>
            {/if}
          </View>
        {/each}
      </View>
    {/each}
  {/snippet}
</Focus>
<FieldError {node} />
