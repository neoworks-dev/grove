<script lang="ts">
  // One shape on a box of its own; shapes that follow each other share one (Kids).
  import Canvas from "./Canvas.svelte";
  import type { NodeProps } from "./Node.svelte";

  let { node, width }: NodeProps = $props();
</script>

<Canvas shapes={[node]} {width} />
