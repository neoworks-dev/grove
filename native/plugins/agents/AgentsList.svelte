<!--
  The agents working for the session, under the composer: one row per subagent or guest while it
  runs and a few seconds after, with its harness and model, what it is doing, how long it has run
  and its tokens. Pressing a row opens that agent's own chat (or its session, when it works in a
  directory of its own); "stop" ends it. Ctrl-X moves the keyboard here: the arrows move between
  the rows, Enter opens one, x stops a running agent, and Escape or the up arrow from the first
  row goes back to the composer. Ported from neoworks-harness apps/gui (plugins/agents).
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { SessionInfo } from "@suite/protocol/types";
  import type { ChatSession } from "./chatSession";
  import { clock } from "./clock";
  import { palette } from "./palette";
  import {
    MAX_ROWS,
    activityOf,
    compact,
    dirLabel,
    elapsed,
    modelLabel,
    shownAgents,
    type AgentRow,
  } from "./subagents";

  interface Props {
    chat: ChatSession;
    sessions: readonly SessionInfo[];
    /** The agent's row was pressed: show its own chat. */
    onopen: (row: AgentRow) => void;
    /** The keyboard was sent back, to the composer. */
    onleave: () => void;
  }

  let { chat, sessions, onopen, onleave }: Props = $props();

  const p = palette;

  const rows = $derived(chat.agentRows());
  const shown = $derived(shownAgents(rows, clock.now));
  const visible = $derived(shown.slice(0, MAX_ROWS));
  const hidden = $derived(shown.length - visible.length);
  const status = $derived(chat.status());

  let region: ReturnType<typeof View> | undefined = $state();
  /** The row the keyboard is on: 0 is the session itself, 1 and up are the agents; -1 while the keyboard is elsewhere. */
  let cursor = $state(-1);

  /** Takes the keyboard, starting on the session's own row; false when there is no list to move through. */
  export function focus(): boolean {
    if (visible.length === 0 || region === undefined) {
      return false;
    }
    cursor = 0;
    region.focus();
    return true;
  }

  /** The keys of the list: the arrows move, Enter opens, x stops, Escape goes back. */
  function key(event: KeyEvent): void {
    if (event.ctrl || event.alt || event.meta) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") {
      cursor = Math.min(cursor + 1, visible.length);
      return;
    }
    if (event.key === "ArrowUp" && cursor > 0) {
      cursor -= 1;
      return;
    }
    if (event.key === "ArrowUp" || event.key === "Escape") {
      onleave();
      return;
    }
    const row = visible[cursor - 1];
    if (row === undefined) {
      if (event.key === "Enter") {
        onleave();
      }
      return;
    }
    if (event.key === "Enter") {
      onopen(row);
      return;
    }
    if (event.key === "x") {
      stop(row);
    }
  }

  /** Agents the user asked to stop, until their end arrives. */
  let stopping = $state.raw<ReadonlySet<string>>(new Set());

  // The elapsed times tick while there is a list, and the lingering rows leave on time.
  $effect(() => {
    if (rows.length === 0) {
      return;
    }
    return clock.join();
  });

  /** Asks the daemon to end the delegation, as the terminal app does. */
  function stop(row: AgentRow): void {
    if (row.state !== "running") {
      return;
    }
    stopping = new Set([...stopping, row.id]);
    void chat.action("agents", "suite.cancel_agent", { id: row.id });
  }

  /** The mark in front of a row and its colour. */
  function glyph(row: AgentRow): { mark: string; color: string } {
    switch (row.state) {
      case "running":
        return { mark: "○", color: p.accent };
      case "done":
        return { mark: "✓", color: p.success };
      case "failed":
        return { mark: "✗", color: p.danger };
      case "stopped":
        return { mark: "✗", color: p.muted };
    }
  }

  /** Harness and model, and the directory of an agent that works in one of its own. */
  function name(row: AgentRow): string {
    let label = row.harness;
    if (row.model !== undefined) {
      label += ` · ${modelLabel(row.model)}`;
    }
    if (row.child !== undefined && row.cwd !== undefined) {
      label += ` ⎇ ${dirLabel(row.cwd)}`;
    }
    return label;
  }

  /** How long it has run, and its tokens once it reported any. */
  function stats(row: AgentRow): string {
    let end = clock.now;
    if (row.endedMs !== undefined) {
      end = row.endedMs;
    }
    const time = elapsed(end - row.startedMs);
    if (row.tokens === undefined) {
      return time;
    }
    return `${time} · ${compact(row.tokens)} tokens`;
  }

  /** What the agent is doing, or that it is being stopped. */
  function doing(row: AgentRow): string {
    if (row.state === "running" && stopping.has(row.id)) {
      return "stopping…";
    }
    return activityOf(row, sessions);
  }
</script>

{#if shown.length > 0}
  <View
    bind:this={region}
    focusable
    onkey={key}
    onblur={() => (cursor = -1)}
    style={{ paddingX: p.space.l, paddingY: p.space.s, borderTopWidth: 1, borderColor: p.border, fontSize: p.text.body - 1 }}
  >
    <View style={{ direction: "row", gap: p.space.s, background: cursor === 0 ? p.band : undefined }}>
      <Text style={{ shrink: 0, color: status.running ? p.accent : p.muted }}>●</Text>
      <Text style={{ shrink: 0 }}>main</Text>
      <Text style={{ shrink: 0, color: p.muted }}>· {status.harness}</Text>
    </View>
    {#each visible as row, index (row.id)}
      {@const mark = glyph(row)}
      <View
        onpress={() => onopen(row)}
        hover={{ background: p.surface }}
        style={{ direction: "row", gap: p.space.m, paddingY: 1, cursor: "pointer", background: cursor === index + 1 ? p.band : undefined }}
      >
        <Text style={{ color: mark.color }}>{mark.mark}</Text>
        <Text style={{ shrink: 0 }}>{name(row)}</Text>
        <Text style={{ flex: 1, minWidth: 0, truncate: true, color: row.state === "failed" ? p.danger : p.muted }}>{doing(row)}</Text>
        <Text style={{ shrink: 0, color: p.muted }}>{stats(row)}</Text>
        {#if row.state === "running"}
          <Button
            onpress={() => stop(row)}
            style={{ paddingX: p.space.s, radius: 4, color: p.muted }}
            hover={{ color: p.danger, background: p.band }}
          >
            <Text>stop</Text>
          </Button>
        {/if}
      </View>
    {/each}
    {#if hidden > 0}
      <Text style={{ color: p.muted }}>  … +{hidden} more</Text>
    {/if}
  </View>
{/if}
