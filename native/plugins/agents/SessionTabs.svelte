<!--
  The strip along the top of an agent pane: one tab for each session of the pane's worktree, a
  button for a new one, and the button that shows the plan and the changed files. A session that
  is running shows a spinner, so one working in a tab you are not looking at is seen. Ported from
  Grove's original agent pane.
-->
<script lang="ts">
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { SessionInfo } from "@suite/protocol/types";
  import sidebar from "@phosphor-icons/core/regular/sidebar-simple.svg";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import spinnerIcon from "@phosphor-icons/core/regular/circle-notch.svg";
  import TabStrip, { type TabEntry } from "../panel/TabStrip.svelte";
  import { palette } from "./palette";
  import { sessionTitle } from "./sessions";

  interface Props {
    sessions: readonly SessionInfo[];
    /** The session the pane shows. */
    current: string;
    /** A tab was pressed. */
    onselect: (sessionId: string) => void;
    /** A tab's close button was pressed. */
    onclose: (sessionId: string) => void;
    /** The new session button was pressed. */
    onnew: () => void;
    /** How many files the session changed and todos it has; none hides the button for the side panel. */
    edits: number;
    /** The plan and the files are showing. */
    panelShown: boolean;
    /** The edits button was pressed. */
    onpanel: () => void;
  }

  let { sessions, current, onselect, onclose, onnew, edits, panelShown, onpanel }: Props = $props();

  const p = palette;
  /** A tab shows this much of a long title; the rest is in the Agents view. */
  const TITLE_LENGTH = 32;
  /** The count on the edits button is set smaller than the palette's code size. */
  const BADGE_TEXT = 10;

  const entries = $derived(sessions.map(tabOf));

  /** A session as a tab: its title, shortened, and a spinner mark while it runs. */
  function tabOf(session: SessionInfo): TabEntry {
    let title = sessionTitle(session);
    if (title.length > TITLE_LENGTH) {
      title = `${title.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
    }
    const tab: TabEntry = { id: session.id, title };
    if (session.state === "running") {
      tab.icon = spinnerIcon;
    }
    return tab;
  }
</script>

<TabStrip tabs={entries} activeId={current} {onselect} {onclose}>
  {#snippet trailing()}
    <Button
      onpress={onnew}
      style={{ size: 24, align: "center", justify: "center", radius: 4, shrink: 0, color: p.muted }}
      hover={{ background: p.band, color: p.fg }}
    >
      <Icon svg={plus} size={12} />
    </Button>
    {#if edits > 0}
      <Button
        onpress={onpanel}
        style={{
          size: 24,
          align: "center",
          justify: "center",
          radius: 4,
          shrink: 0,
          marginRight: 6,
          background: panelShown ? p.band : undefined,
          color: panelShown ? p.fg : p.muted,
        }}
        hover={{ background: p.band, color: p.fg }}
      >
        <Icon svg={sidebar} size={14} />
        <View
          style={{
            position: "absolute",
            top: -2,
            right: -5,
            minWidth: 14,
            height: 14,
            paddingX: 3,
            radius: 7,
            align: "center",
            justify: "center",
            background: panelShown ? p.fg : p.elevatedBorder,
            color: panelShown ? p.bg : p.fg,
          }}
        >
          <Text style={{ fontSize: BADGE_TEXT }}>{edits}</Text>
        </View>
      </Button>
    {/if}
  {/snippet}
</TabStrip>
