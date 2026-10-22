<script lang="ts">
  // A tab strip over the selected tab's children. Which tab is selected is only visual, kept in
  // the doc's view.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { useDoc } from "./context";
  import { childPath } from "./paths";
  import Kids from "./Kids.svelte";
  import { nodes, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const tabs = $derived(nodes(node, "tabs"));
  const at = $derived(Math.min(Math.max(0, doc.view.tab(path)), Math.max(0, tabs.length - 1)));
  const selected = $derived(tabs[at]);

  function go(to: number): void {
    doc.view.tabs[path] = Math.min(tabs.length - 1, Math.max(0, to));
  }
</script>

<View style={{ gap: 12 }}>
  <View style={{ direction: "row", wrap: true, gap: 4, borderBottomWidth: 1, borderColor: p.border }}>
      {#each tabs as tab, index}
        <View
          onpress={() => go(index)}
          hover={{ color: p.fg }}
          style={{
            paddingX: 12,
            paddingY: 7,
            marginBottom: -1,
            borderBottomWidth: 2,
            borderColor: index === at ? p.accent : "transparent",
            color: index === at ? p.fg : p.muted,
            cursor: "pointer",
            radius: [6, 6, 0, 0],
          }}
        >
          <Text style={{ fontWeight: index === at ? "medium" : "normal", nowrap: true }}>{str(tab, "label") ?? ""}</Text>
        </View>
      {/each}
  </View>
  {#if selected}
    <Kids children={nodes(selected, "children")} path={childPath(path, "tabs", at)} {width} />
  {/if}
</View>
