<!--
  The strip along the top of an agent pane: one tab for each session of the pane's worktree, a
  button for a new one, and the button that shows the plan and the changed files. A session that
  is running shows a spinner, so one working in a tab you are not looking at is seen. Ported from
  Grove's original agent pane.
-->
<script lang="ts">
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { SessionInfo } from "@suite/protocol/types";
  import pencil from "@phosphor-icons/core/regular/pencil-simple.svg";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import Spinner from "./chat/Spinner.svelte";
  import { palette } from "./palette";
  import { sessionTitle } from "./sessions";

  interface Props {
    sessions: readonly SessionInfo[];
    /** The session the pane shows. */
    current: string;
    /** A tab was pressed. */
    onselect: (sessionId: string) => void;
    /** The new session button was pressed. */
    onnew: () => void;
    /** How many files the session changed; none hides the edits button. */
    edits: number;
    /** The plan and the files are showing. */
    panelShown: boolean;
    /** The edits button was pressed. */
    onpanel: () => void;
  }

  let { sessions, current, onselect, onnew, edits, panelShown, onpanel }: Props = $props();

  const p = palette;
</script>

<View
  style={{
    direction: "row",
    align: "center",
    gap: p.space.s,
    paddingX: p.space.m,
    paddingY: p.space.s,
    borderBottomWidth: 1,
    borderColor: p.border,
  }}
>
  <View style={{ direction: "row", gap: p.space.s, flex: 1, minWidth: 0, overflow: "hidden" }}>
    {#each sessions as session (session.id)}
      {@const selected = session.id === current}
      <Button
        onpress={() => onselect(session.id)}
        style={{
          direction: "row",
          align: "center",
          gap: p.space.s,
          paddingX: p.space.m,
          height: 24,
          radius: 4,
          shrink: 1,
          minWidth: 40,
          maxWidth: 180,
          background: selected ? p.band : undefined,
          color: selected ? p.fg : p.muted,
        }}
        hover={{ background: p.band, color: p.fg }}
      >
        {#if session.state === "running"}
          <View style={{ color: p.accent, shrink: 0 }}><Spinner /></View>
        {/if}
        <Text style={{ truncate: true, minWidth: 0, fontSize: p.text.code }}>{sessionTitle(session)}</Text>
      </Button>
    {/each}
    <Button
      onpress={onnew}
      style={{ size: 24, align: "center", justify: "center", radius: 4, shrink: 0, color: p.muted }}
      hover={{ background: p.band, color: p.fg }}
    >
      <Icon svg={plus} size={12} />
    </Button>
  </View>
  {#if edits > 0}
    <Button
      onpress={onpanel}
      style={{
        direction: "row",
        align: "center",
        gap: p.space.s,
        paddingX: p.space.m,
        height: 24,
        radius: 4,
        shrink: 0,
        background: panelShown ? p.band : undefined,
        color: panelShown ? p.accent : p.muted,
      }}
      hover={{ background: p.band, color: p.fg }}
    >
      <Icon svg={pencil} size={12} />
      <Text style={{ fontSize: p.text.code }}>Edits {edits}</Text>
    </Button>
  {/if}
</View>
