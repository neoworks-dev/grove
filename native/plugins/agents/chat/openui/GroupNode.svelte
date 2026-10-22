<script lang="ts">
  // CheckBoxGroup and SwitchGroup: one line per item with its description muted under it. The group
  // is one stop of the keyboard: Up and Down move a cursor between the items, Space toggles the one
  // under it. The value is a list of the checked names, or an object of name to flag.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import Focus from "./Focus.svelte";
  import { flip, groupHas } from "./form";
  import Mark from "./Mark.svelte";
  import { groupItems, str } from "./props";
  import Toggle from "./Toggle.svelte";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const key = $derived(node.key ?? "");
  const switches = $derived(node.component === "SwitchGroup");
  const items = $derived(groupItems(node));
  const value = $derived(doc.value(node));
  const error = $derived(str(node, "error") !== undefined);
  const off = $derived(doc.streaming);
  const cursor = $derived(Math.min(doc.view.cursors[key] ?? 0, Math.max(0, items.length - 1)));
  $effect(() => doc.view.echoed(key, node.props["value"]));

  function toggle(name: string): void {
    if (!off) doc.input(node, flip(value, items, name, switches));
  }

  function onkey(event: KeyEvent): void {
    if (event.key === " " || event.key === "Enter") {
      const item = items[cursor];
      if (item !== undefined) toggle(item.name);
    } else if (event.key === "ArrowUp" && cursor > 0) {
      doc.view.cursors[key] = cursor - 1;
    } else if (event.key === "ArrowDown" && cursor + 1 < items.length) {
      doc.view.cursors[key] = cursor + 1;
    } else {
      return;
    }
    event.preventDefault();
  }
</script>

<Focus id={key} disabled={off} {onkey} style={{ gap: 4, opacity: off ? 0.6 : undefined }}>
  {#snippet children(focused)}
    {#each items as item, index}
      <View
        onpress={() => {
          doc.view.cursors[key] = index;
          toggle(item.name);
        }}
        style={{ direction: "row", gap: 10, paddingX: 6, paddingY: 4, radius: p.radius.s, background: focused && index === cursor ? p.hover : undefined, cursor: off ? undefined : "pointer" }}
      >
        <View style={{ paddingTop: 1 }}>
          {#if switches}
            <Toggle on={groupHas(value, item.name)} focused={focused && index === cursor} />
          {:else}
            <Mark on={groupHas(value, item.name)} focused={focused && index === cursor} {error} />
          {/if}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: focused && index === cursor ? p.accent : p.fg }}>{item.label}</Text>
          {#if item.description}
            <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{item.description}</Text>
          {/if}
        </View>
      </View>
    {/each}
  {/snippet}
</Focus>
<FieldError {node} />
