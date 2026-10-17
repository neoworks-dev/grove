<!--
  A session's chat in a pane: the session tabs along the top, the conversation over its composer
  and the agents list, with the plan and changed files in a column at the right when the pane is
  wide enough. The edits button shows the column in a narrow pane, where it takes the place of the
  conversation, and hides it in a wide one. Pressing an agent in the list shows that agent's own
  chat in place of the conversation.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { Layout } from "@neoworks/svelte-gpui/ui";
  import type { WorkspaceService } from "../workspace/service";
  import AgentChatView from "./AgentChatView.svelte";
  import AgentsList from "./AgentsList.svelte";
  import type { ChatSession } from "./chatSession";
  import Chat from "./chat/Chat.svelte";
  import Composer from "./Composer.svelte";
  import SessionTabs from "./SessionTabs.svelte";
  import { FilesModel, type ChangesSource } from "./filesModel";
  import { modelLabel, type AgentRow } from "./subagents";
  import SidePanel from "./SidePanel.svelte";
  import type { AgentsService } from "./service";

  interface Props {
    agents: AgentsService;
    workspace: WorkspaceService;
    changes: ChangesSource;
    chat: ChatSession;
    /** The pane this is drawn in. */
    leafId: string;
    /** The pane this is drawn in has the focus. */
    focused: boolean;
  }

  let { agents, workspace, changes, chat, leafId, focused }: Props = $props();

  /** The pane is only worth a column for the plan and files from this width on. */
  const MIN_WIDTH_FOR_SIDE_PANEL = 760;
  /** How soon after a change git is asked again, so a burst of edits is one ask. */
  const REFRESH_DELAY_MS = 200;
  /** How often git is asked anyway, since the user edits files too. */
  const REFRESH_INTERVAL_MS = 10_000;

  const files = new FilesModel(
    untrack(() => changes),
    () => workspace.worktrees(),
    untrack(() => chat),
    () => agents.sessionInfo(untrack(() => chat).sessionId)?.cwd,
  );

  let width = $state(0);
  /** What the user chose for the plan and files column; undefined while the pane's width decides. */
  let panelChoice = $state<boolean | undefined>(undefined);
  /** The agent whose own chat is shown, and that chat. */
  let viewedAgent = $state.raw<AgentRow | null>(null);
  let agentChat = $state.raw<ChatSession | null>(null);

  const running = $derived(chat.running());
  const plans = $derived(chat.plans());
  const entries = $derived(files.entries());
  const wide = $derived(width >= MIN_WIDTH_FOR_SIDE_PANEL);
  const hasPanelContent = $derived(plans.length > 0 || entries.length > 0);
  const sidePanelShown = $derived.by(() => {
    if (!hasPanelContent) {
      return false;
    }
    if (panelChoice === undefined) {
      return wide;
    }
    return panelChoice;
  });
  /** A narrow pane gives the whole pane to the column, since beside the chat it would leave the chat no room. */
  const panelReplacesChat = $derived(sidePanelShown && !wide);
  const tabs = $derived(agents.siblingSessions(chat.sessionId));
  const branch = $derived(files.worktree()?.branch ?? null);

  // Git is asked when the files the agents touched change or a turn ends, and now and then.
  $effect(() => {
    void chat.touches();
    void running;
    void files.worktree()?.id;
    const timer = setTimeout(() => void files.refresh(), REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    const timer = setInterval(() => void files.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  // The chat of the agent that was pressed follows its view until the user goes back.
  $effect(() => {
    const row = viewedAgent;
    if (row === null) {
      return;
    }
    const opened = untrack(() => agents.openAgentChat(chat.sessionId, row.harness));
    agentChat = opened;
    return () => {
      opened?.stop();
      agentChat = null;
    };
  });

  /** An agent's row was pressed: its own chat, or its session when it works in a directory of its own. */
  function openAgent(row: AgentRow): void {
    if (row.child !== undefined) {
      agents.openSession(row.child);
      return;
    }
    viewedAgent = row;
  }

  /** The model as it is shown in the agent's header. */
  function shownModel(row: AgentRow): string | undefined {
    if (row.model === undefined) {
      return undefined;
    }
    return modelLabel(row.model);
  }

  /** The edits button: shows the plan and files, or hides them. */
  function togglePanel(): void {
    panelChoice = !sidePanelShown;
  }

  function measured(box: Layout): void {
    width = box.width;
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  <SessionTabs
    sessions={tabs}
    current={chat.sessionId}
    onselect={(sessionId) => agents.showSession(leafId, sessionId)}
    onnew={() => void agents.newSession()}
    edits={entries.length}
    panelShown={sidePanelShown}
    onpanel={togglePanel}
  />
  <View style={{ flex: 1, minHeight: 0, direction: "row" }} onlayout={measured}>
    {#if !panelReplacesChat}
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {#if viewedAgent !== null && agentChat !== null}
          <AgentChatView
            chat={agentChat}
            harness={viewedAgent.harness}
            model={shownModel(viewedAgent)}
            task={viewedAgent.task}
            onback={() => (viewedAgent = null)}
          />
        {:else}
          <Chat session={chat} />
          <Composer session={chat} {running} {focused} />
        {/if}
        <AgentsList {chat} sessions={agents.sessions()} onopen={openAgent} />
      </View>
    {/if}
    {#if sidePanelShown}
      <SidePanel {chat} {files} {branch} fill={panelReplacesChat} />
    {/if}
  </View>
</View>
