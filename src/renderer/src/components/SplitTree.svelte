<script lang="ts">
  // Recursive renderer for the layout tree. Splits become flex containers with
  // fraction-sized children separated by gutters; leaves become PaneLeaf
  // windows. Imports itself for recursion.
  import SplitTree from './SplitTree.svelte'
  import SplitGutter from './SplitGutter.svelte'
  import PaneLeaf from './PaneLeaf.svelte'
  import type { LayoutNode } from '../lib/layoutTree'

  let { node }: { node: LayoutNode } = $props()
</script>

{#if node.kind === 'leaf'}
  <PaneLeaf leaf={node} />
{:else}
  <div
    class="flex h-full w-full min-w-0 min-h-0 flex-1 {node.direction === 'row'
      ? 'flex-row'
      : 'flex-col'}"
  >
    {#each node.children as child, index (child.id)}
      {#if index > 0}
        <SplitGutter split={node} gutterIndex={index - 1} />
      {/if}
      <div class="flex min-w-0 min-h-0" style="flex:{node.sizes[index]} 1 0%">
        <SplitTree node={child} />
      </div>
    {/each}
  </div>
{/if}
