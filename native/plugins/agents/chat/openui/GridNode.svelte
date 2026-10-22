<script lang="ts">
  // Children in as many columns as fit (at most `columns`), left to right and then down.
  import { neouiPalette } from "./look";
  import Cells from "./Cells.svelte";
  import { columnsFor, GRID_MIN } from "./layout";
  import { nodes, num } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const items = $derived(nodes(node, "children").map((child, index) => ({ node: child, index })));
  const gap = 12;
  const columns = $derived(columnsFor(width, items.length, GRID_MIN, gap, num(node, "columns")));
</script>

<Cells {items} {columns} {width} {gap} {path} />
