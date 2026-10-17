<!--
  The main area: the layout service's split tree, with each pane showing the `main` slot's entry
  for its pane type. A pane's title and icon come from that entry's props. Pressing inside a pane
  focuses it, and a pane can be closed while it is not the only one.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { useKernel } from "../../kernel/kernel";
  import Slot from "../../kernel/slots/Slot.svelte";
  import type { SlotEntry } from "../../kernel/slots/registry";
  import { colors, fontSize } from "../theme/tokens";
  import PaneLeaf from "./PaneLeaf.svelte";
  import SplitTree from "./SplitTree.svelte";
  import type { LayoutService } from "./service";

  let { layout }: { layout: LayoutService } = $props();

  const kernel = useKernel();

  /** The `main` entry that draws a pane type, if a plugin registered one. */
  function entryFor(paneTypeId: string): SlotEntry | undefined {
    return kernel.slots.entries("main").find((entry) => entry.key === paneTypeId);
  }

  /** The title a pane type's entry gives it, or the type's name while there is no entry. */
  function titleFor(paneTypeId: string): string {
    const props = entryFor(paneTypeId)?.props;
    if (props && typeof props.title === "string") {
      return props.title;
    }
    return paneTypeId;
  }

  /** The icon a pane type's entry gives it, if any. */
  function iconFor(paneTypeId: string): string | undefined {
    const props = entryFor(paneTypeId)?.props;
    if (props && typeof props.icon === "string") {
      return props.icon;
    }
    return undefined;
  }

  /** The close handler for a pane: none while it is the only one, so the last pane has no button. */
  function closeHandlerFor(leafId: string): (() => void) | undefined {
    if (layout.leafCount() <= 1) {
      return undefined;
    }
    return () => layout.closeLeaf(leafId);
  }
</script>

<View style={{ flex: 1, minHeight: 0, direction: "row" }}>
  <SplitTree node={layout.root} host={layout}>
    {#snippet leaf(node)}
      <PaneLeaf
        leafId={node.id}
        title={titleFor(node.paneTypeId)}
        icon={iconFor(node.paneTypeId)}
        active={layout.focusedLeafId === node.id}
        onclose={closeHandlerFor(node.id)}
        ondroppane={(draggedLeafId, zone) => layout.dropPane(draggedLeafId, node.id, zone)}
      >
        <View style={{ flex: 1, minHeight: 0 }} ondown={() => layout.focus(node.id)}>
          {#if entryFor(node.paneTypeId)}
            <Slot name="main" key={node.paneTypeId} props={{ leafId: node.id }} />
          {:else}
            <Text style={{ padding: 12, fontSize: fontSize.xs, color: colors.dim }}>No plugin shows "{node.paneTypeId}" panes.</Text>
          {/if}
        </View>
      </PaneLeaf>
    {/snippet}
  </SplitTree>
</View>
