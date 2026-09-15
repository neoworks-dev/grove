<script lang="ts">
  // Recursive renderer for the layout tree. Splits become flex containers with
  // fraction-sized children separated by gutters; leaves become PaneLeaf
  // windows. Imports itself for recursion.
  //
  // Focus mode folds the tree down to the branch holding the focused pane: the
  // other branches keep their DOM (hidden) so nothing remounts, and the visible
  // one takes the whole container.
  import SplitTree from './SplitTree.svelte'
  import SplitGutter from './SplitGutter.svelte'
  import PaneLeaf from './PaneLeaf.svelte'
  import { layout } from '../lib/layout.svelte'
  import type { LayoutNode } from '../lib/layoutTree'

  let { node }: { node: LayoutNode } = $props()

  /** Flex basis for a child: its stored fraction, or the whole container while zoomed. */
  function childFlex(fraction: number): string {
    if (layout.focusMode) return '1 1 0%'
    return `${fraction} 1 0%`
  }
</script>

{#if node.kind === 'leaf'}
  <PaneLeaf leaf={node} />
{:else}
  <div
    data-split-id={node.id}
    class="flex h-full w-full min-w-0 min-h-0 flex-1 {node.direction === 'row'
      ? 'flex-row'
      : 'flex-col'}"
  >
    {#each node.children as child, index (child.id)}
      {@const visible = layout.isNodeVisible(child.id)}
      {#if index > 0 && !layout.focusMode}
        <SplitGutter split={node} gutterIndex={index - 1} />
      {/if}
      <div
        class="flex min-w-0 min-h-0"
        class:hidden={!visible}
        style:flex={childFlex(node.sizes[index])}
      >
        <SplitTree node={child} />
      </div>
    {/each}
  </div>
{/if}
