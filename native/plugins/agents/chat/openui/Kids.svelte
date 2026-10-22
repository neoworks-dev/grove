<script lang="ts">
  // The children of a column Stack, a Card, a Tab or an accordion item. A run of sibling Cards is
  // drawn as a grid and a run of Metrics as a strip, whatever the program says, as in the terminal;
  // a run of Shapes is one canvas. A Box takes the width it asks for: a share of the column, what
  // its content needs, or all of it.
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { UiNode } from "@suite/protocol/types";
  import Canvas from "./Canvas.svelte";
  import Cells from "./Cells.svelte";
  import { childPath } from "./paths";
  import { askOf, columnsFor, GRID_MIN, segments, shareWidth } from "./layout";
  import MetricStrip from "./MetricStrip.svelte";
  import Node from "./Node.svelte";

  interface Props {
    children: UiNode[];
    path: string;
    width: number;
    /** The prop the children are under, for their paths. */
    prop?: string;
    gap?: number;
    align?: "start" | "center" | "end" | "stretch";
    /** Leading children drawn elsewhere (a card's cover picture); the rest keep their paths. */
    skip?: number;
  }

  let { children, path, width, prop = "children", gap = 12, align = "stretch", skip = 0 }: Props = $props();
  const parts = $derived(segments(children).filter((part) => part.kind !== "node" || part.at.index >= skip));
</script>

<!-- The transparent border is no decoration: without any border or fill, the host laid a column of
  these out taller than its children in some docs (an option card row among fields), by up to a
  third. -->
<View style={{ gap, align, borderWidth: 1, borderColor: "transparent" }}>
  {#each parts as part}
    {#if part.kind === "node"}
      {@const ask = askOf(part.at.node)}
      {#if typeof ask === "number"}
        <View style={{ width: shareWidth(ask, width), alignSelf: "start" }}>
          <Node node={part.at.node} path={childPath(path, prop, part.at.index)} width={shareWidth(ask, width)} />
        </View>
      {:else if ask === "fit"}
        <View style={{ alignSelf: "start", maxWidth: width }}>
          <Node node={part.at.node} path={childPath(path, prop, part.at.index)} {width} />
        </View>
      {:else}
        <Node node={part.at.node} path={childPath(path, prop, part.at.index)} {width} />
      {/if}
    {:else if part.kind === "shapes"}
      <Canvas shapes={part.items.map((at) => at.node)} {width} />
    {:else if part.kind === "cards"}
      <Cells items={part.items} columns={columnsFor(width, part.items.length, GRID_MIN, gap)} {width} {gap} {path} {prop} />
    {:else}
      <MetricStrip items={part.items} {width} {path} {prop} />
    {/if}
  {/each}
</View>
