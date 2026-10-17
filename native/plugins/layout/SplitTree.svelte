<!--
  Recursive renderer for the layout tree. A split is a flex container whose children share its
  space by the fractions in the tree, separated by gutters; a leaf is whatever the `leaf` snippet
  draws for it (a `PaneLeaf`, usually). A pane whose type holds a fixed size keeps its pixels and
  its siblings absorb every change around it. A pane mid-collapse counts as empty so the split
  never shows a gap.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { View, type Layout } from "@neoworks/svelte-gpui/ui";
  import SplitGutter from "./SplitGutter.svelte";
  import SplitTree from "./SplitTree.svelte";
  import { parseFlex } from "./flex";
  import type { LayoutHost } from "./host";
  import { splitChildFlex, type LayoutNode, type SplitNode } from "./layoutTree";

  interface Props {
    node: LayoutNode;
    host: LayoutHost;
    /** Draws one leaf of the tree. */
    leaf: Snippet<[Extract<LayoutNode, { kind: "leaf" }>]>;
  }

  let { node, host, leaf }: Props = $props();

  // Pixels each child currently takes along the split's axis, by node id.
  let childPx = $state<Record<string, number>>({});

  /** The split's own node, for the branch that is one. */
  function asSplit(candidate: LayoutNode): SplitNode | null {
    if (candidate.kind !== "split") {
      return null;
    }
    return candidate;
  }

  const split = $derived(asSplit(node));

  /** One flex setting per child, from the shares in the tree and the children that hold pixels. */
  const childFlex = $derived.by(() => {
    if (!split) {
      return [];
    }
    const collapsing = split.children.map((child) => child.id === host.collapsingLeafId);
    const sizes = split.sizes.map((size, index) => {
      if (collapsing[index]) {
        return 0;
      }
      return size;
    });
    const fixedPx = split.children.map((child, index) => {
      if (collapsing[index]) {
        return null;
      }
      return host.fixedSizePx(child);
    });
    return splitChildFlex(sizes, fixedPx).map(parseFlex);
  });

  /** Records a child's size along the split's axis, and hands a fixed pane the size it first shows at. */
  function measureChild(child: LayoutNode, layout: Layout): void {
    if (!split) {
      return;
    }
    let along = layout.height;
    if (split.direction === "row") {
      along = layout.width;
    }
    const first = childPx[child.id] === undefined;
    childPx[child.id] = along;
    if (first && child.kind === "leaf" && host.fixedSizePx(child) === null) {
      host.adoptFixedSizePx?.(child.id, along);
    }
  }

  /** The two panes either side of a gutter, together, in pixels. */
  function pairPx(current: SplitNode, gutterIndex: number): number {
    const before = childPx[current.children[gutterIndex].id] ?? 0;
    const after = childPx[current.children[gutterIndex + 1].id] ?? 0;
    return before + after;
  }
</script>

{#if node.kind === "leaf"}
  {@render leaf(node)}
{:else if split}
  <View style={{ flex: 1, minWidth: 0, minHeight: 0, direction: split.direction }}>
    {#each split.children as child, index (child.id)}
      {#if index > 0}
        <SplitGutter {split} gutterIndex={index - 1} {host} pairPx={pairPx(split, index - 1)} />
      {/if}
      <View
        style={{
          grow: childFlex[index].grow,
          shrink: childFlex[index].shrink,
          basis: childFlex[index].basis,
          minWidth: 0,
          minHeight: 0,
        }}
        onresize={(layout) => measureChild(child, layout)}
      >
        <SplitTree node={child} {host} {leaf} />
      </View>
    {/each}
  </View>
{/if}
