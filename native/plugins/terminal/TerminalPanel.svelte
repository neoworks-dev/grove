<!--
  The terminal tab of the bottom panel: the shown terminal, with a list of the selected worktree's
  terminals down its right side and a button for another, as VS Code lays it out. Terminals of
  the other worktrees keep running; their entries come back when the worktree is selected again.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Icon, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";
  import x from "@phosphor-icons/core/regular/x.svg";
  import { colors, fontSize, iconButton, iconButtonHover, radius } from "../theme/tokens";
  import type { TerminalService } from "./service";
  import TerminalSurface from "./TerminalSurface.svelte";

  /** The width of the list of terminals. */
  const LIST_WIDTH = 190;
  const ROW_HEIGHT = 26;

  let { service }: { service: TerminalService } = $props();

  const terminals = $derived(service.panelTerminals());
  const active = $derived(service.activePanelTerminal());
  let hoveredId = $state<string | null>(null);

  // A worktree without a terminal gets one when the panel is drawn for it, as the first entry of an
  // opened panel and as the panel follows a worktree switch.
  $effect(() => {
    if (active === null) {
      untrack(() => service.ensurePanelTerminal());
    }
  });

  /** Remembers which entry the pointer is over, whose close button shows. */
  function trackHover(terminalId: string, hovered: boolean): void {
    if (hovered) {
      hoveredId = terminalId;
      return;
    }
    if (hoveredId === terminalId) {
      hoveredId = null;
    }
  }

  /** Whether an entry shows its close button: the shown one and the one under the pointer do. */
  function showsClose(terminalId: string): boolean {
    if (active !== null && active.id === terminalId) {
      return true;
    }
    return hoveredId === terminalId;
  }

  /** The background of an entry: the shown terminal's stands out. */
  function entryBackground(terminalId: string): string {
    if (active !== null && active.id === terminalId) {
      return colors.hover;
    }
    return "transparent";
  }
</script>

<View style={{ flex: 1, minHeight: 0, direction: "row" }}>
  <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
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
  <View style={{ width: LIST_WIDTH, shrink: 0, minHeight: 0, borderLeftWidth: 1, borderColor: colors.lineFaint }}>
    <Scroll style={{ flex: 1, minHeight: 0 }}>
      <View style={{ padding: 4, gap: 2 }}>
        {#each terminals as info (info.id)}
          <View
            style={{
              direction: "row",
              align: "center",
              gap: 6,
              height: ROW_HEIGHT,
              paddingLeft: 8,
              paddingRight: 2,
              radius: radius.sm,
              cursor: "pointer",
              background: entryBackground(info.id),
              fontSize: fontSize.xs,
              color: active !== null && active.id === info.id ? colors.text : colors.muted,
            }}
            hover={{ background: colors.hover }}
            onhover={(hovered: boolean) => trackHover(info.id, hovered)}
            onpress={() => service.selectPanelTerminal(info.id)}
          >
            <Icon svg={terminalWindow} size={13} />
            <Text style={{ flex: 1, minWidth: 0, truncate: true }}>{info.title}</Text>
            {#if info.bell}
              <View style={{ size: 6, radius: 3, shrink: 0, background: colors.accent }}></View>
            {/if}
            {#if showsClose(info.id)}
              <Button style={{ ...iconButton, size: 20, shrink: 0 }} hover={iconButtonHover} onpress={() => service.close(info.id)}>
                <Icon svg={x} size={11} />
              </Button>
            {/if}
          </View>
        {/each}
        <Button
          style={{ direction: "row", align: "center", gap: 6, height: ROW_HEIGHT, paddingLeft: 8, radius: radius.sm, fontSize: fontSize.xs, color: colors.dim }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={() => service.newPanelTerminal()}
        >
          <Icon svg={plus} size={13} />
          <Text>New terminal</Text>
        </Button>
      </View>
    </Scroll>
  </View>
</View>
