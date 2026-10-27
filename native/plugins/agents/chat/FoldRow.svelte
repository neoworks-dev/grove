<script lang="ts">
  // The line a folded turn, or a run of settled calls, is reduced to. Pressing it shows what it
  // hides.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { palette } from "../palette";
  import ItemFrame from "./ItemFrame.svelte";
  import Tallies from "./Tallies.svelte";
  import type { Tally } from "./turns";
  import { chatView } from "./viewState";

  interface Props {
    /** What opening it is remembered under. */
    foldKey: string;
    open: boolean;
    tallies: readonly Tally[];
    /** The messages a folded turn hid, none for a run. */
    messages?: number;
    /** How many steps the fold hides, said when there is neither a call nor a message to name. */
    steps?: number;
  }

  let { foldKey, open, tallies, messages = 0, steps = 0 }: Props = $props();

  const p = palette;

  /** `1 message` or `3 messages`. */
  function messageLabel(count: number): string {
    if (count === 1) {
      return "1 message";
    }
    return `${count} messages`;
  }

  /** `1 step` or `4 steps`. */
  function stepLabel(count: number): string {
    if (count === 1) {
      return "1 step";
    }
    return `${count} steps`;
  }
</script>

<ItemFrame>
  <View
    onpress={() => chatView.toggleOpened(foldKey)}
    style={{ direction: "row", align: "center", gap: p.space.m, paddingX: p.space.l, cursor: "pointer" }}
  >
    <Text style={{ width: 10, color: p.muted, fontFamily: "mono", fontSize: p.text.code, shrink: 0 }}>{open ? "⌄" : "›"}</Text>
    <Text style={{ color: p.success, fontSize: p.text.code, shrink: 0 }}>●</Text>
    <Tallies {tallies} />
    {#if messages > 0}
      <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, shrink: 0 }}>{messageLabel(messages)}</Text>
    {/if}
    {#if tallies.length === 0 && messages === 0}
      <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, shrink: 0 }}>{stepLabel(steps)}</Text>
    {/if}
  </View>
</ItemFrame>
