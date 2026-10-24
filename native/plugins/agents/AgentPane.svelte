<!--
  An agent pane: one session's chat over its composer, in a pane of the main area. Until the daemon
  is reachable, and until the pane has a session, it says what is missing instead.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import AgentSession from "./AgentSession.svelte";
  import { clock } from "./clock";
  import type { LayoutService } from "../layout/service";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { WorkspaceService } from "../workspace/service";
  import type { ChangesSource } from "./filesModel";
  import type { FileIconSource } from "../explorer/fileIcons";
  import type { AgentsService } from "./service";

  interface Props {
    agents: AgentsService;
    layout: LayoutService;
    workspace: WorkspaceService;
    /** Where the files panel reads the worktree's changes from. */
    changes: ChangesSource;
    /** Where the files panel takes its file icons from. */
    icons: FileIconSource;
    /** The pane this is drawn in. */
    leafId?: string;
  }

  let { agents, layout, workspace, changes, icons, leafId = "main" }: Props = $props();

  const sessionId = $derived(agents.sessionOfPane(leafId));
  const connection = $derived(agents.state());
  const chat = $derived(sessionId === null ? undefined : agents.chat(sessionId));
  const focused = $derived(layout.focusedLeafId === leafId);
  const retryAt = $derived(connection.retryAt);
  /** Whole seconds until the service tries the daemon again by itself. */
  const retrySeconds = $derived.by(() => {
    if (retryAt === undefined) {
      return undefined;
    }
    return Math.max(0, Math.ceil((retryAt - clock.now) / 1000));
  });

  // The countdown moves while there is one.
  $effect(() => {
    if (retryAt === undefined) {
      return;
    }
    return clock.join();
  });

  // The daemon is told which session the pane the user is in shows, and moves the agent here with it.
  $effect(() => {
    if (focused && sessionId !== null) {
      void agents.showing(sessionId);
    }
  });

  // The pane follows its session while it shows it, and the daemon starts when the first pane needs it.
  $effect(() => {
    if (sessionId === null) {
      return;
    }
    return agents.follow(sessionId);
  });
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if connection.connection === "unavailable"}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 8, padding: 24 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.text }}>Can't reach the suite daemon</Text>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{connection.message === undefined ? "" : connection.message}</Text>
      {#if retrySeconds !== undefined}
        <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Trying again in {retrySeconds}s</Text>
      {/if}
      <Button
        onpress={() => void agents.retry()}
        style={{ paddingX: 12, height: 26, align: "center", radius: radius.md, background: colors.hover, color: colors.text }}
        hover={{ background: colors.raised }}
      >
        <Text style={{ fontSize: fontSize.xs }}>Try again</Text>
      </Button>
    </View>
  {:else if sessionId === null}
    <View style={{ flex: 1, align: "center", justify: "center", gap: 4 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.muted }}>No session open</Text>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Pick one in the Agents sidebar, or start a new one.</Text>
    </View>
  {:else if chat === undefined}
    <View style={{ flex: 1, align: "center", justify: "center" }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Connecting to the suite daemon…</Text>
    </View>
  {:else}
    <!-- The view is given the chat once, not a way to look it up. Closing the pane next to this one
         makes the service let go of the session for a moment, and a view that looked the chat up
         again would find none while it is torn down. A new chat for the session is a new view. -->
    {#key chat}
      <AgentSession {agents} {workspace} {changes} {icons} chat={untrack(() => chat) as ChatSession} {leafId} {focused} />
    {/key}
  {/if}
</View>
