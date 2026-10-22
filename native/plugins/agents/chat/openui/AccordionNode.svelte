<script lang="ts">
  // Collapsible sections. Each title is a stop of the keyboard: Enter or Space toggles, Right opens,
  // Left closes. Which items are open is only visual, kept here.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import down from "@phosphor-icons/core/regular/caret-down.svg";
  import right from "@phosphor-icons/core/regular/caret-right.svg";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import Focus from "./Focus.svelte";
  import { childPath } from "./paths";
  import Kids from "./Kids.svelte";
  import { bool, nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();
  const items = $derived(nodes(node, "items"));

  const isOpen = (index: number): boolean =>
    doc.view.isOpen(childPath(path, "items", index), bool(items[index] ?? node, "open") === true);

  function set(index: number, open: boolean): void {
    doc.view.open[childPath(path, "items", index)] = open;
  }

  function key(event: KeyEvent, index: number): void {
    if (event.key === "Enter" || event.key === " ") set(index, !isOpen(index));
    else if (event.key === "ArrowRight") set(index, true);
    else if (event.key === "ArrowLeft") set(index, false);
    else return;
    event.preventDefault();
  }
</script>

<View style={{ borderWidth: 1, borderColor: p.border, radius: p.radius.s, overflow: "hidden" }}>
  {#each items as item, index}
    {@const at = childPath(path, "items", index)}
    <View style={{ borderTopWidth: index === 0 ? 0 : 1, borderColor: p.border }}>
      <Focus
        id={at}
        onkey={(event) => key(event, index)}
        onpress={() => set(index, !isOpen(index))}
        style={{ direction: "row", align: "center", gap: 8, paddingX: 12, paddingY: 9, cursor: "pointer" }}
      >
        {#snippet children(focused)}
          <View style={{ color: p.muted }}><Icon svg={isOpen(index) ? down : right} size={14} /></View>
          <Text style={{ flex: 1, minWidth: 0, fontWeight: "medium", color: focused ? p.accent : p.fg }}>{str(item, "title") ?? ""}</Text>
        {/snippet}
      </Focus>
      {#if isOpen(index)}
        <View style={{ paddingX: 12, paddingBottom: 12, paddingLeft: 34 }}>
          <Kids children={nodes(item, "children")} path={at} width={width - 48} />
        </View>
      {/if}
    </View>
  {/each}
</View>
