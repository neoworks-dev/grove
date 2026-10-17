<!--
  A terminal in a pane of the main area. The pane's state names its terminal, and a pane that has
  none gets one when it appears, so a split of a terminal pane is a new shell. A shell that ended in
  the only pane left offers a new one.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { LayoutService } from "../layout/service";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { TerminalService } from "./service";
  import TerminalSurface from "./TerminalSurface.svelte";

  interface Props {
    service: TerminalService;
    layout: LayoutService;
    /** The pane this is drawn in. */
    leafId?: string;
  }

  let { service, layout, leafId = "main" }: Props = $props();

  const terminal = $derived(service.paneTerminal(leafId));
  // Primitives, so the effect below reruns when the terminal changes and not when its title does.
  const terminalId = $derived(terminal === null ? null : terminal.id);
  const exited = $derived(terminal !== null && terminal.exited);

  // A pane made by a split, or opened as a terminal, asks for its shell here.
  $effect(() => {
    service.ensurePaneTerminal(leafId);
  });

  // The pane that has the focus has the keyboard in its terminal.
  $effect(() => {
    if (terminalId !== null && !exited && layout.focusedLeafId === leafId) {
      untrack(() => service.requestFocus(terminalId));
    }
  });
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if terminal !== null && terminal.exited}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 8 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>The shell ended</Text>
      <Button
        style={{ paddingX: 10, paddingY: 5, radius: radius.sm, background: colors.hover, fontSize: fontSize.xs, color: colors.text }}
        hover={{ background: colors.raised }}
        onpress={() => service.ensurePaneTerminal(leafId, true)}
      >
        <Text>Start a new shell</Text>
      </Button>
    </View>
  {:else if terminal !== null}
    <TerminalSurface {service} {terminal} onfocus={() => layout.focus(leafId)} />
  {/if}
</View>
