<!--
  The status bar as the frame draws it: its items are the `statusbar` slot's entries. An entry
  picks its side with `align: "left" | "right"` in its props (left when it says nothing) and its
  place on that side with its `order`, which the slot has already sorted by.
-->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import type { SlotEntry } from "../../kernel/slots/registry";
  import StatusBar, { type StatusItem } from "./StatusBar.svelte";

  const kernel = useKernel();

  /** Which side an entry asks for. */
  function alignOf(entry: SlotEntry): "left" | "right" {
    if (entry.props && entry.props.align === "right") {
      return "right";
    }
    return "left";
  }

  /** The status item an entry draws; the slot's own order already ranks the entries, so a running index keeps it. */
  function itemOf(entry: SlotEntry, index: number): StatusItem {
    return { id: entry.id, order: index, align: alignOf(entry), component: entry.component, props: entry.props };
  }

  const items = $derived(kernel.slots.entries("statusbar").map(itemOf));
</script>

<StatusBar {items} onerror={(itemId, error) => kernel.reportError(`statusbar ${itemId}`, error)} />
