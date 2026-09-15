<script lang="ts">
  // Recursive renderer for the layout tree. Splits become flex containers with
  // fraction-sized children separated by gutters; leaves become PaneLeaf
  // windows. Imports itself for recursion.
  //
  // Two sizing modes live here. Most panes take a share of the container, so
  // they grow and shrink with it. A pane whose type declares a fixed size holds
  // its pixels instead and its siblings absorb every change around it.
  //
  // Focus mode folds the tree down to the branch holding the focused pane: the
  // other branches keep their DOM (hidden) so nothing remounts, and the visible
  // one takes the whole container.
  import SplitTree from './SplitTree.svelte'
  import SplitGutter from './SplitGutter.svelte'
  import PaneLeaf from './PaneLeaf.svelte'
  import { layout } from '../lib/layout.svelte'
  import { splitChildFlex, type LayoutNode } from '../lib/layoutTree'

  let { node }: { node: LayoutNode } = $props()

  // Axis this node lays its children out on; unused when the node is a leaf.
  const direction = $derived(node.kind === 'split' ? node.direction : 'row')

  // One `flex` shorthand per child, from the shares in the tree and whichever
  // children hold a pixel size. Zoomed, the one visible child takes everything.
  const childFlex = $derived.by(() => {
    if (node.kind !== 'split') return []
    if (layout.focusMode) return node.children.map(() => '1 1 0%')
    const fixedPx = node.children.map((child) => layout.fixedSizePx(child))
    return splitChildFlex(node.sizes, fixedPx)
  })

  /**
   * Hand a fixed pane the width it is already rendering at, once, when it
   * mounts. A layout saved before fixed sizing carries no pixels, so this is
   * what stops it from jumping to the pane type's default on first paint.
   */
  function adoptSize(element: HTMLElement, child: LayoutNode): void {
    if (child.kind !== 'leaf' || layout.fixedSizePx(child) !== null) return
    requestAnimationFrame(() => {
      const px = direction === 'row' ? element.offsetWidth : element.offsetHeight
      layout.adoptFixedSizePx(child.id, px)
    })
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
        style:flex={childFlex[index]}
        use:adoptSize={child}
      >
        <SplitTree node={child} />
      </div>
    {/each}
  </div>
{/if}
