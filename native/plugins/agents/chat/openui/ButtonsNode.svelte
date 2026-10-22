<script lang="ts">
  // A row of buttons.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { childPath } from "./paths";
  import Node from "./Node.svelte";
  import { nodes } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
</script>

<View style={{ direction: "row", wrap: true, gap: 8 }}>
  {#each nodes(node, "buttons") as button, index}
    <Node node={button} path={childPath(path, "buttons", index)} {width} />
  {/each}
</View>
