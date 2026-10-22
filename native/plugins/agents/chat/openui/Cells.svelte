<script lang="ts">
  // Children in rows of equal columns, every cell of a row as tall as its tallest, so cards line up.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { childPath } from "./paths";
  import { cellWidth, chunk, type Placed } from "./layout";
  import Node from "./Node.svelte";

  interface Props {
    items: Placed[];
    columns: number;
    width: number;
    gap: number;
    path: string;
    prop?: string;
  }

  let { items, columns, width, gap, path, prop = "children" }: Props = $props();
  const cell = $derived(cellWidth(width, columns, gap));
  const rows = $derived(chunk(items, columns));
</script>

<View style={{ gap }}>
  {#each rows as row}
    <View style={{ direction: "row", gap, align: "stretch" }}>
      {#each row as at}
        <View style={{ width: cell }}>
          <Node node={at.node} path={childPath(path, prop, at.index)} width={cell} fill />
        </View>
      {/each}
    </View>
  {/each}
</View>
