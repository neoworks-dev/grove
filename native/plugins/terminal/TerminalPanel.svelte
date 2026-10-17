<!--
  The terminal tab of the bottom panel: a tab for each terminal of the selected worktree, a button
  for another, and the shown terminal below. Terminals of the other worktrees keep running; their
  tabs come back when the worktree is selected again.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import TabStrip, { type TabEntry } from "../panel/TabStrip.svelte";
  import { colors, fontSize, iconButton, iconButtonHover } from "../theme/tokens";
  import type { TerminalService } from "./service";
  import TerminalSurface from "./TerminalSurface.svelte";

  const MAX_TAB_TITLE = 28;

  let { service }: { service: TerminalService } = $props();

  /** Titles from a shell can be a whole path; a tab keeps the end of it, which says more. */
  function tabTitle(title: string): string {
    if (title.length <= MAX_TAB_TITLE) {
      return title;
    }
    return `…${title.slice(title.length - MAX_TAB_TITLE + 1)}`;
  }

  const terminals = $derived(service.panelTerminals());
  const active = $derived(service.activePanelTerminal());

  // A worktree without a terminal gets one when the panel is drawn for it, as the first tab of an
  // opened panel and as the panel follows a worktree switch.
  $effect(() => {
    if (active === null) {
      untrack(() => service.ensurePanelTerminal());
    }
  });

  const entries = $derived<TabEntry[]>(terminals.map((info) => ({ id: info.id, title: tabTitle(info.title), dirty: info.bell })));
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  <TabStrip
    tabs={entries}
    activeId={active === null ? "" : active.id}
    onselect={(id) => service.selectPanelTerminal(id)}
    onclose={(id) => service.close(id)}
  >
    {#snippet trailing()}
      <Button style={{ ...iconButton, size: 24 }} hover={iconButtonHover} onpress={() => service.newPanelTerminal()}>
        <Icon svg={plus} size={14} />
      </Button>
    {/snippet}
  </TabStrip>
  {#if active !== null}
    {#key active.id}
      <TerminalSurface {service} terminal={active} />
    {/key}
  {:else}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 6 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>No terminal open</Text>
      <Button
        style={{ paddingX: 10, paddingY: 5, radius: 4, background: colors.hover, fontSize: fontSize.xs, color: colors.text }}
        hover={{ background: colors.raised }}
        onpress={() => service.newPanelTerminal()}
      >
        <Text>New terminal</Text>
      </Button>
    </View>
  {/if}
</View>
