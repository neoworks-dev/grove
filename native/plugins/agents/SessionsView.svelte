<!--
  The agents view: the suite daemon's sessions for the open repository, grouped by worktree with the
  shown worktree first. Pressing a session opens its chat in a pane, and "New" starts a session in the
  shown worktree. The daemon is started the first time the view is drawn.
-->
<script lang="ts">
  import { Button, Icon, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { WorkspaceService } from "../workspace/service";
  import Spinner from "./chat/Spinner.svelte";
  import { age, previewOf, sessionTitle, type SessionGroup, type SessionRowData } from "./sessions";
  import type { AgentsService } from "./service";

  interface Props {
    agents: AgentsService;
    workspace: WorkspaceService;
  }

  let { agents, workspace }: Props = $props();

  /** One line of the list: a worktree's heading, a session, or the note under an empty heading. */
  type Entry =
    | { kind: "group"; key: string; group: SessionGroup }
    | { kind: "session"; key: string; row: SessionRowData }
    | { kind: "empty"; key: string };

  const connection = $derived(agents.state());
  const repo = $derived(workspace.repo());
  const groups = $derived(agents.groups());
  const entries = $derived(entriesOf(groups));
  const sessionCount = $derived(groups.reduce((count, group) => count + group.rows.length, 0));

  /** The time the ages are counted to; moves on while the view is drawn. */
  let now = $state(Date.now());

  // The daemon starts the first time the view is drawn, and the ages move on while it is.
  $effect(() => {
    void agents.ensureStarted();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** The groups as the lines the list draws. */
  function entriesOf(shown: SessionGroup[]): Entry[] {
    const lines: Entry[] = [];
    for (const group of shown) {
      lines.push({ kind: "group", key: `group ${group.key}`, group });
      if (group.rows.length === 0) {
        lines.push({ kind: "empty", key: `empty ${group.key}` });
      }
      for (const row of group.rows) {
        lines.push({ kind: "session", key: row.info.id, row });
      }
    }
    return lines;
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if connection.connection === "unavailable"}
    <View style={{ padding: 12, gap: 8 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.text }}>Can't reach the suite daemon.</Text>
      {#if connection.message !== undefined}
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>{connection.message}</Text>
      {/if}
      <Button
        onpress={() => void agents.retry()}
        style={{ alignSelf: "start", paddingX: 10, height: 24, align: "center", radius: radius.sm, background: colors.hover, color: colors.text, fontSize: fontSize.xs }}
        hover={{ background: colors.raised }}
      >
        <Text>Try again</Text>
      </Button>
    </View>
  {:else if repo === null}
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Open a folder to see its agent sessions.</Text>
    </View>
  {:else}
    <View style={{ direction: "row", align: "center", gap: 2, height: 28, shrink: 0, paddingLeft: 12, paddingRight: 6 }}>
      <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>
        {#if connection.connection === "open"}{sessionCount} sessions{:else}Connecting…{/if}
      </Text>
      <Button
        style={{ height: 22, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
        hover={{ background: colors.hover, color: colors.text }}
        onpress={() => void agents.newSession()}
      >
        <Icon svg={plus} size={12} />
        <Text>New session</Text>
      </Button>
    </View>

    <List items={entries} key={(entry: Entry) => entry.key} style={{ flex: 1, minHeight: 0 }}>
      {#snippet row(entry: Entry)}
        {#if entry.kind === "group"}
          <View style={{ direction: "row", align: "center", gap: 6, paddingX: 12, paddingTop: 10, paddingBottom: 4 }}>
            <Text style={{ flex: 1, minWidth: 0, truncate: true, fontFamily: "mono", fontSize: fontSize.xxs, color: entry.group.selected ? colors.text : colors.dim }}>
              {entry.group.name}
            </Text>
          </View>
        {:else if entry.kind === "empty"}
          <Text style={{ paddingX: 12, paddingY: 4, fontSize: fontSize.xxs, color: colors.faint }}>No sessions here yet.</Text>
        {:else}
          {@const info = entry.row.info}
          {@const shown = agents.isShown(info.id)}
          <View
            style={{
              direction: "row",
              gap: 8,
              paddingLeft: entry.row.child ? 24 : 12,
              paddingRight: 12,
              paddingY: 6,
              background: shown ? colors.elevated : "transparent",
              cursor: "pointer",
            }}
            hover={{ background: colors.hover }}
            onpress={() => agents.openSession(info.id)}
          >
            <View style={{ width: 12, shrink: 0, color: colors.accent }}>
              {#if info.state === "running"}<Spinner />{/if}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <View style={{ direction: "row", gap: 6 }}>
                <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.sm, color: shown ? colors.text : colors.muted }}>
                  {entry.row.child ? "↳ " : ""}{sessionTitle(info)}
                </Text>
                <Text style={{ shrink: 0, fontSize: fontSize.xxs, color: colors.dim }}>{age(info.lastActivity, now)}</Text>
              </View>
              {#if previewOf(info) !== ""}
                <Text style={{ truncate: true, minWidth: 0, fontSize: fontSize.xxs, color: colors.dim }}>{previewOf(info)}</Text>
              {/if}
            </View>
          </View>
        {/if}
      {/snippet}
    </List>
  {/if}
</View>
