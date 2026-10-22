<script lang="ts">
  // Suggested next questions as pills, side by side and wrapping. Choosing one sends its text to
  // the assistant.
  import { View } from "@neoworks/svelte-gpui/ui";
  import Pill from "./Pill.svelte";
  import { nodes } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node }: NodeProps = $props();
</script>

<View style={{ direction: "row", wrap: true, gap: 8 }}>
  {#each nodes(node, "items") as item}
    <Pill node={item} />
  {/each}
</View>
