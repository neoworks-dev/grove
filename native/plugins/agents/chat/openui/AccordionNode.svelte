<script lang="ts">
  // Collapsible sections. Which items are open is only visual, kept in the doc's view.
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import down from "@phosphor-icons/core/regular/caret-down.svg";
  import right from "@phosphor-icons/core/regular/caret-right.svg";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
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
</script>

<View style={{ borderWidth: 1, borderColor: p.border, radius: p.radius.s, overflow: "hidden" }}>
  {#each items as item, index}
    {@const at = childPath(path, "items", index)}
    <View style={{ borderTopWidth: index === 0 ? 0 : 1, borderColor: p.border }}>
      <View
        onpress={() => set(index, !isOpen(index))}
        style={{ direction: "row", align: "center", gap: 8, paddingX: 12, paddingY: 9, cursor: "pointer" }}
      >
        <View style={{ color: p.muted }}><Icon svg={isOpen(index) ? down : right} size={14} /></View>
        <Text style={{ flex: 1, minWidth: 0, fontWeight: "medium", color: p.fg }}>{str(item, "title") ?? ""}</Text>
      </View>
      {#if isOpen(index)}
        <View style={{ paddingX: 12, paddingBottom: 12, paddingLeft: 34 }}>
          <Kids children={nodes(item, "children")} path={at} width={width - 48} />
        </View>
      {/if}
    </View>
  {/each}
</View>
