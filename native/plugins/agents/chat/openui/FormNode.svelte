<script lang="ts">
  // Fields submitted together: their controls, then the buttons. Enter in a field presses the first button.
  import { View } from "@neoworks/svelte-gpui/ui";
  import { childPath } from "./paths";
  import { provideForm } from "./formcontext";
  import Kids from "./Kids.svelte";
  import Node from "./Node.svelte";
  import { child, nodes } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  provideForm(() => node);
  const buttons = $derived(child(node, "buttons"));
</script>

<View style={{ gap: 14 }}>
  <Kids children={nodes(node, "children")} {path} {width} gap={14} />
  {#if buttons}
    <Node node={buttons} path={childPath(path, "buttons")} {width} />
  {/if}
</View>
