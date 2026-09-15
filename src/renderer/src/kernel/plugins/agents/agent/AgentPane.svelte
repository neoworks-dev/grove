<script lang="ts">
  // The agent pane.
  //
  // Sessions, transcripts, approvals and persistence belong to the main process,
  // which runs whichever harness the session names; this is a client for them,
  // plus the two things that are the pane's own business — which worktree a
  // session belongs to, and how its file changes get reviewed.

  import Icon from '@iconify/svelte'
  import Eye from 'phosphor-svelte/lib/Eye'
  import { onDestroy, onMount } from 'svelte'
  import { openFileInEditor, selectWorktree, store } from '../../../../lib/store.svelte'
  import { keymap } from '../../../../lib/keymap.svelte'
  import { settings } from '../../../../lib/settings.svelte'
  import { review } from '../../../../lib/review.svelte'
  import { catalog } from '../../../../lib/agents/catalog.svelte'
  import {
    badgeOf,
    agentSessions,
    type LiveSession,
    type SessionBadge
  } from '../../../../lib/agents/sessions.svelte'
  import { pendingApprovals, visibleItems } from '../../../../lib/agents/transcript'
  import {
    liveAgentIds,
    parentIdOf,
    sessionByAgentId,
    subagentOf,
    subagentSessions
  } from '../../../../lib/agents/sessionTree'
  import { fileOfCall } from '../../../../lib/agents/tools'
  import { questionsOf } from '../../../../lib/agents/questions'
  import {
    activeToolsFor,
    effectiveMode,
    nextMode,
    type AgentMode
  } from '../../../../lib/agents/modes'
  import { nextThinkingLevel } from '../../../../lib/agents/thinking'
  import type {
    ClientEventBody,
    ConfirmationResult,
    SessionMeta,
    ThinkingLevel,
    ToolInfo
  } from '../../../../lib/agents/types'
  import AgentApproval from './AgentApproval.svelte'
  import AgentComposer from './AgentComposer.svelte'
  import AgentQuestion from './AgentQuestion.svelte'
  import AgentControls from './AgentControls.svelte'
  import AgentOverview from './AgentOverview.svelte'
  import AgentQueue from './AgentQueue.svelte'
  import AgentSessionTabs from './AgentSessionTabs.svelte'
  import AgentTranscript from './AgentTranscript.svelte'
  import AgentWorkingBar from './AgentWorkingBar.svelte'
  import CredentialPrompt from './CredentialPrompt.svelte'

  let { leafId }: { leafId: string } = $props()

  const worktree = $derived(store.selectedWorktree)
  const worktreePath = $derived(worktree?.path ?? '')

  const sessionList = $derived(worktreePath ? agentSessions.forWorktree(worktreePath) : [])
  const activeId = $derived(worktreePath ? agentSessions.resolveActive(worktreePath) : null)
  // Every session there is, not just this worktree's: a message quotes whoever
  // sent it, and a sender still running elsewhere is not a closed one.
  const liveAgents = $derived(liveAgentIds(agentSessions.list))
  const live = $derived<LiveSession | undefined>(
    activeId ? agentSessions.live[activeId] : undefined
  )
  const snapshot = $derived(live?.snapshot ?? null)

  // Reviews are recorded under the harness that made the changes, so the queue
  // for this session is looked up by the harness it is running on.
  const activeMeta = $derived(sessionList.find((session) => session.id === activeId))
  const harness = $derived.by(() => {
    if (snapshot) return snapshot.harness
    if (activeMeta) return activeMeta.harness
    return ''
  })

  const items = $derived(live ? visibleItems(live.transcript) : [])
  // What has already been said here, oldest first: the composer steps back
  // through the conversation itself, so history outlives the window it was
  // typed in the way the transcript does.
  const promptHistory = $derived.by(() => {
    const said = items.filter((item) => item.kind === 'user')
    return said.map((item) => item.text).filter((text) => text.trim().length > 0)
  })
  const approvals = $derived(live ? pendingApprovals(live.transcript) : [])
  // A parked call whose input is a set of questions is one, whatever the
  // harness named the tool.
  const questions = $derived(approvals[0] ? questionsOf(approvals[0].input) : null)
  const running = $derived(live?.transcript.status === 'running')
  // A session standing for an agent the harness ran inside a tool call. It is a
  // record of that conversation: the runtime is the only thing that ever spoke
  // there, so there is nothing to write to.
  const subagent = $derived(activeMeta ? subagentOf(activeMeta) : null)
  // Every tool call in this worktree that ran an agent, so a call in the
  // transcript can lead to the conversation it ran.
  const agentCallSessions = $derived(subagentSessions(agentSessions.list))
  // The session that started this one, for the way back out of a subagent's.
  const parentSession = $derived.by(() => {
    if (!activeMeta) return null
    const parentId = parentIdOf(activeMeta)
    if (!parentId) return null
    return sessionList.find((session) => session.id === parentId) ?? null
  })
  const queued = $derived(snapshot?.queued ?? [])

  // The chosen mode leads the session state: accept-edits and bypass are entered
  // by answering approvals, so a session that has not seen one yet still reports
  // "default". The choice itself lives in the session store, because approvals
  // have to be answered whoever started the run.
  const mode = $derived(
    activeId ? effectiveMode(agentSessions.modeFor(activeId), snapshot) : 'default'
  )

  // The fleet view, reached by stepping left out of an empty composer.
  let overviewOpen = $state(false)
  let expandedTools = $state<Record<string, boolean>>({})
  let transcriptViewport = $state<HTMLDivElement>()
  let composer = $state<{ focus: () => void }>()
  let stickToBottom = $state(true)
  let disposeBindings: (() => void) | undefined

  // ── Settings ────────────────────────────────────────────────────

  // The harness a new session starts on: the last one chosen, else the first
  // that can actually run.
  const newSessionHarness = $derived(
    settings.get<string>('workbench.agentHarness') || (catalog.available[0]?.id ?? '')
  )

  // The effort a new session opens on. Chosen levels are remembered here as
  // well as on the session, so the next one starts where the last was left
  // instead of back at "off".
  const rememberedThinking = $derived(
    settings.get<ThinkingLevel>('workbench.agentThinking') ?? 'off'
  )

  const reviewMode = $derived(settings.get<string>('workbench.reviewMode') ?? 'pre')
  const reviewPause = $derived(settings.get<boolean>('workbench.reviewPause') ?? false)

  function setReviewSetting(key: string, value: string | boolean): void {
    void settings.set(key, value, 'user')
  }

  // ── Review ──────────────────────────────────────────────────────

  // The batch raised for the approval on screen, if the review bridge staged one.
  const gatedReview = $derived(approvals[0] ? review.gatedFor(approvals[0].toolUseId) : null)
  const reviewIsOpen = $derived(gatedReview !== null && review.active?.id === gatedReview.id)
  const postReviews = $derived(
    worktreePath && activeId
      ? review.queueFor(worktreePath, harness, activeId).filter((batch) => batch.origin !== 'gated')
      : []
  )

  // ── Lifecycle ───────────────────────────────────────────────────

  onMount(() => {
    const unwatch = agentSessions.watch()
    void catalog.load()
    disposeBindings = registerBindings()
    return unwatch
  })

  onDestroy(() => disposeBindings?.())

  // Follow the selection: open a stream for the session on screen, and tell the
  // store which one it is so its unread count clears.
  $effect(() => {
    const id = activeId
    agentSessions.view(id)
    if (id) void agentSessions.open(id)
  })

  // The catalog answers for one harness at a time; point it at this session's,
  // or at the one a new session would start on when there is none.
  $effect(() => {
    void catalog.use(harness || newSessionHarness || null)
  })

  // Keep the newest output in view unless the user has scrolled away from it.
  //
  // Watching the transcript grow, rather than the item list, is what makes this
  // follow a streaming answer: a turn's text arrives as deltas into the row that
  // is already there, so the list stops changing long before the content does.
  // The same observer covers markdown and images that lay out a frame late.
  $effect(() => {
    const content = transcriptViewport?.firstElementChild
    if (!content) return

    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    return () => observer.disconnect()
  })

  // A session switched in brings a whole transcript with it, which is a jump to
  // the bottom rather than a growth the observer would see.
  $effect(() => {
    void activeId
    scrollToBottom()
  })

  function scrollToBottom(): void {
    if (!stickToBottom || !transcriptViewport) return
    transcriptViewport.scrollTop = transcriptViewport.scrollHeight
  }

  function onTranscriptScroll(): void {
    if (!transcriptViewport) return
    const distance =
      transcriptViewport.scrollHeight -
      transcriptViewport.scrollTop -
      transcriptViewport.clientHeight
    stickToBottom = distance < 40
  }

  // ── Sessions ────────────────────────────────────────────────────

  /**
   * A new session runs the harness the user last chose, and otherwise whichever
   * one the main process finds available.
   */
  async function createSession(): Promise<void> {
    if (!worktreePath) return
    await agentSessions.create(worktreePath, {
      title: `Session ${sessionList.length + 1}`,
      harness: newSessionHarness || undefined,
      thinkingLevel: rememberedThinking
    })
  }

  async function closeSession(sessionId: string, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    if (!worktreePath) return
    await agentSessions.remove(worktreePath, sessionId)
  }

  function selectSession(sessionId: string): void {
    if (!worktreePath) return
    agentSessions.setActive(worktreePath, sessionId)
  }

  function cycleSession(step: number): void {
    if (sessionList.length === 0) return
    const current = sessionList.findIndex((session) => session.id === activeId)
    const next = (current + step + sessionList.length) % sessionList.length
    selectSession(sessionList[next].id)
  }

  // ── Overview ────────────────────────────────────────────────────
  //
  // Sessions in other worktrees are reachable without leaving the pane, which is
  // what makes watching several agents at once a matter of stepping left and
  // picking the one that wants attention.

  function showOverview(): void {
    overviewOpen = true
    // The list drives itself from the keyboard, so the pane's normal-mode keys
    // (j/k scrolling a transcript that is no longer on screen) stay out of its way.
    keymap.setPaneMode(leafId, 'insert')
  }

  /** Leave the overview for the session the pane was already on. */
  function closeOverview(): void {
    overviewOpen = false
    focusComposerNextFrame()
  }

  /** Jump the pane to a session from the overview, selecting its worktree. */
  async function openFromOverview(worktreeId: string, sessionId: string): Promise<void> {
    overviewOpen = false
    agentSessions.setActive(worktreeId, sessionId)
    if (worktreeId !== store.selectedWorktreeId) await selectWorktree(worktreeId)
    focusComposerNextFrame()
  }

  /** The composer only exists once the transcript is back on screen. */
  function focusComposerNextFrame(): void {
    requestAnimationFrame(() => composer?.focus())
  }

  /**
   * Show the conversation of the agent that sent a message.
   *
   * Its session is usually in this worktree — an agent can only address the
   * agents it shares one with — but the listing is searched whole, so a session
   * whose worktree has since been switched away from is still reachable.
   */
  function openAgent(agentId: string): void {
    const session = sessionByAgentId(agentSessions.list, agentId)
    if (!session) return
    void openFromOverview(session.workspaceRoot, session.id)
  }

  function badgeFor(session: SessionMeta): SessionBadge {
    return badgeOf(session, agentSessions.live[session.id])
  }

  function unreadFor(session: SessionMeta): number {
    return agentSessions.live[session.id]?.unread ?? 0
  }

  // ── Sending ─────────────────────────────────────────────────────

  function send(events: ClientEventBody[]): void {
    if (!activeId) return
    void agentSessions.send(activeId, events)
    stickToBottom = true
  }

  function decide(toolUseId: string, result: ConfirmationResult, reason?: string): Promise<void> {
    if (!activeId) return Promise.resolve()
    return agentSessions.send(activeId, [
      { type: 'user.tool_confirmation', toolUseId, result, reason }
    ])
  }

  /** Let the asking call run, with the user's answers written into its input. */
  function answerQuestion(input: unknown): void {
    const pending = approvals[0]
    if (!activeId || !pending) return
    void agentSessions.send(activeId, [
      { type: 'user.tool_confirmation', toolUseId: pending.toolUseId, result: 'allow', input }
    ])
  }

  function interrupt(): void {
    if (!activeId) return
    void agentSessions.send(activeId, [{ type: 'user.interrupt' }])
  }

  function unqueue(messageId: string): void {
    if (!activeId) return
    void agentSessions.send(activeId, [{ type: 'user.unqueue', messageId }])
  }

  // ── Session settings ────────────────────────────────────────────

  function pickModel(provider: string, model: string): void {
    if (!activeId) return
    void agentSessions.update(activeId, { provider, model })
  }

  // The variables a route asked for, while the dialog collecting one is open.
  let credentialRequest = $state<string[] | null>(null)

  function requestCredential(variables: string[]): void {
    credentialRequest = variables
  }

  /** A stored key changes which routes are ready, so the catalog is re-read. */
  function closeCredentialPrompt(stored: boolean): void {
    credentialRequest = null
    if (stored) void catalog.reload()
  }

  /**
   * Switching harness restarts the conversation on the new runtime: the old one's
   * resume key means nothing to it. The choice is remembered so new sessions
   * start there too.
   */
  function pickHarness(next: string): void {
    void settings.set('workbench.agentHarness', next, 'user')
    if (!activeId || next === harness) return
    void agentSessions.update(activeId, { harness: next })
  }

  function pickThinking(thinkingLevel: ThinkingLevel): void {
    void settings.set('workbench.agentThinking', thinkingLevel, 'user')
    if (!activeId) return
    void agentSessions.update(activeId, { thinkingLevel })
  }

  // ── Cycling from the keyboard ───────────────────────────────────
  //
  // Both step through their list in place, so the setting can be changed while
  // typing a prompt without reaching for the menus under the composer.

  function cycleMode(): void {
    pickMode(nextMode(mode))
  }

  function cycleThinking(): void {
    const current = snapshot?.thinkingLevel ?? rememberedThinking
    pickThinking(nextThinkingLevel(current))
  }

  /**
   * Plan mode is a session change (it withholds tools); the other two only
   * decide how approvals get answered, so they take effect as calls arrive.
   */
  function pickMode(next: AgentMode): void {
    if (!activeId) return
    agentSessions.setMode(activeId, next)
    const allTools = catalog.tools.map((tool) => tool.name)
    void agentSessions.update(activeId, { activeTools: activeToolsFor(next, allTools) })
  }

  // ── Editor handoff ──────────────────────────────────────────────

  /** Tool paths are absolute or workspace-relative; the editor wants absolute. */
  function openFile(path: string): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    const absolute = path.startsWith('/') ? path : `${worktreePath}/${path}`
    openFileInEditor(worktreeId, absolute)
  }

  function showChange(): void {
    if (gatedReview) void review.open(gatedReview.id)
  }

  // ── Follow mode ─────────────────────────────────────────────────
  //
  // With it on, every file the agent reads or writes opens in the editor as the
  // call appears, so the editor tracks the agent instead of being clicked along.

  const following = $derived(settings.get<boolean>('workbench.agentFollow') ?? false)

  function toggleFollow(): void {
    void settings.set('workbench.agentFollow', !following, 'user')
  }

  // Calls already followed, and the session they belong to. A call that was on
  // screen before follow mode came on is history, not something to replay into
  // the editor.
  let followedCalls = new Set<string>()
  let followedSession: string | null = null

  function callIdsOnScreen(): Set<string> {
    const ids = new Set<string>()
    for (const item of items) {
      if (item.kind === 'tool') ids.add(item.toolUseId)
    }
    return ids
  }

  function displayOf(name: string): ToolInfo['display'] {
    return catalog.tools.find((tool) => tool.name === name)?.display
  }

  /** Opens the file of every call seen for the first time; only ever moves forward. */
  function followNewCalls(): void {
    for (const item of items) {
      if (item.kind !== 'tool') continue
      if (followedCalls.has(item.toolUseId)) continue
      followedCalls.add(item.toolUseId)
      const path = fileOfCall(displayOf(item.name), item.editedInput ?? item.input, worktreePath)
      if (path) openFile(path)
    }
  }

  $effect(() => {
    // Follow mode off, or a session just switched in: take what is on screen as
    // already seen and wait for the next call.
    if (!following || activeId !== followedSession) {
      followedSession = activeId
      followedCalls = callIdsOnScreen()
      return
    }
    followNewCalls()
  })

  // ── Keybindings ─────────────────────────────────────────────────

  function focusComposer(): void {
    composer?.focus()
  }

  function scrollTranscript(delta: number): void {
    transcriptViewport?.scrollBy({ top: delta })
  }

  function scrollTranscriptPage(fraction: number): void {
    if (!transcriptViewport) return
    transcriptViewport.scrollBy({ top: transcriptViewport.clientHeight * fraction })
  }

  function registerBindings(): () => void {
    return keymap.registerBindings([
      {
        id: `agent.insert:${leafId}`,
        keys: 'i',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Insert mode (focus composer)',
        run: focusComposer
      },
      {
        id: `agent.scrollDown:${leafId}`,
        keys: 'j',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll transcript down',
        run: () => scrollTranscript(60)
      },
      {
        id: `agent.scrollUp:${leafId}`,
        keys: 'k',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll transcript up',
        run: () => scrollTranscript(-60)
      },
      {
        id: `agent.halfDown:${leafId}`,
        keys: 'ctrl+d',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll half page down',
        run: () => scrollTranscriptPage(0.5)
      },
      {
        id: `agent.halfUp:${leafId}`,
        keys: 'ctrl+u',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll half page up',
        run: () => scrollTranscriptPage(-0.5)
      },
      {
        id: `agent.pageDown:${leafId}`,
        keys: 'pagedown',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll page down',
        run: () => scrollTranscriptPage(0.9)
      },
      {
        id: `agent.pageUp:${leafId}`,
        keys: 'pageup',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll page up',
        run: () => scrollTranscriptPage(-0.9)
      },
      {
        id: `agent.toggleFollow:${leafId}`,
        keys: 'f',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Follow the agent in the editor',
        run: toggleFollow
      },
      {
        id: `agent.cycleMode:${leafId}`,
        keys: 'shift+tab',
        context: leafId,
        group: 'Agent',
        description: 'Cycle permission mode',
        run: cycleMode
      },
      {
        id: `agent.cycleThinking:${leafId}`,
        keys: 'ctrl+tab',
        context: leafId,
        group: 'Agent',
        description: 'Cycle reasoning effort',
        run: cycleThinking
      },
      {
        id: `agent.overview:${leafId}`,
        keys: 'left',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Session overview',
        run: showOverview
      },
      {
        id: `agent.prevSession:${leafId}`,
        keys: 'alt+h',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Previous session',
        run: () => cycleSession(-1)
      },
      {
        id: `agent.nextSession:${leafId}`,
        keys: 'alt+l',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Next session',
        run: () => cycleSession(1)
      }
    ])
  }

  function onComposerFocus(focused: boolean): void {
    keymap.setPaneMode(leafId, focused ? 'insert' : 'normal')
  }

  // ── Display helpers ─────────────────────────────────────────────

  const contextLabel = $derived.by(() => {
    if (!snapshot) return ''
    const used = snapshot.context.usedTokens
    if (used <= 0) return ''
    return `${(used / 1000).toFixed(1)}k · ${Math.round(snapshot.context.ratio * 100)}%`
  })

  const errorText = $derived(live?.error || agentSessions.serverError || catalog.error)
</script>

<div class="flex h-full flex-col">
  {#if !worktree}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <!-- Tabs scroll; the follow toggle is pinned beside them so it stays reachable. -->
    <div class="flex shrink-0 items-center">
      <div class="flex min-w-0 flex-1">
        <AgentSessionTabs
          sessions={sessionList}
          {activeId}
          {badgeFor}
          {unreadFor}
          onSelect={selectSession}
          onClose={closeSession}
          onCreate={createSession}
        />
      </div>
      <button
        class="mr-1.5 flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs {following
          ? 'bg-elevated text-blue'
          : 'text-dim hover:bg-hover hover:text-default'}"
        title="Follow mode: open every file the agent reads or writes (f)"
        aria-pressed={following}
        onclick={toggleFollow}
      >
        <Eye width="13" height="13" weight={following ? 'fill' : 'regular'} />
        Follow
      </button>
    </div>

    {#if errorText}
      <div class="shrink-0 border-b border-red/30 bg-red-soft px-3 py-1.5 text-2xs text-red">
        {errorText}
      </div>
    {/if}

    {#if overviewOpen}
      <!-- The fleet replaces the conversation: picking one is what returns. -->
      <AgentOverview activeSessionId={activeId} onOpen={openFromOverview} onClose={closeOverview} />
    {:else if activeId && live}
      <AgentTranscript
        sessionId={activeId}
        {items}
        tools={catalog.tools}
        root={worktreePath}
        {expandedTools}
        thinking={running && approvals.length === 0}
        {running}
        toggleTool={(id) => (expandedTools = { ...expandedTools, [id]: !expandedTools[id] })}
        onOpenFile={openFile}
        onOpenAgent={openAgent}
        onOpenSession={selectSession}
        subagentSessions={agentCallSessions}
        liveAgentIds={liveAgents}
        bind:viewport={transcriptViewport}
        onscroll={onTranscriptScroll}
      />
    {:else}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3">
        <p class="text-xs text-dim">No agent session in this worktree.</p>
        <!-- Pick the harness before starting: switching afterwards restarts the
             conversation, since the new runtime knows nothing of the old one. -->
        <div class="flex items-center gap-1">
          {#each catalog.harnesses as entry (entry.id)}
            <button
              class="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-2xs hover:bg-hover disabled:opacity-50 {entry.id ===
              newSessionHarness
                ? 'text-default'
                : 'text-dim'}"
              disabled={!entry.available}
              title={entry.detail ?? entry.description}
              onclick={() => pickHarness(entry.id)}
            >
              <Icon icon={entry.icon} class="size-3.5 shrink-0" />
              {entry.label}
            </button>
          {/each}
        </div>
        <button
          class="rounded-md bg-action px-3 py-1 text-xs text-action-fg"
          onclick={createSession}
        >
          New session
        </button>
      </div>
    {/if}

    {#if running && !overviewOpen}
      <AgentWorkingBar tokensLabel={contextLabel} />
    {/if}

    {#if queued.length > 0 && !overviewOpen}
      <AgentQueue messages={queued} onCancel={unqueue} />
    {/if}

    {#if !overviewOpen}
      <div class="relative shrink-0 p-2">
        {#if postReviews.length > 0}
          <!-- Post-approve reviews: the writes are already on disk, so nothing is
             blocked on these. Opening one shows its diff in the editor. -->
          {#each postReviews as batch (batch.id)}
            <div
              class="mb-2 flex items-center gap-2 rounded-md border border-amber/30 bg-amber-soft px-2 py-1.5 text-2xs text-amber"
            >
              <span class="min-w-0 flex-1 truncate">
                {batch.summary || 'Changes ready for review'}
                <span class="text-dim">
                  · {batch.files.length} file{batch.files.length === 1 ? '' : 's'}
                </span>
              </span>
              <button
                class="shrink-0 rounded bg-amber px-2 py-0.5 text-action-fg"
                onclick={() => void review.open(batch.id)}
              >
                Review
              </button>
            </div>
          {/each}
        {/if}

        {#if approvals[0] && reviewIsOpen}
          <!-- The review's own controls in the editor are answering this one. -->
          <div
            class="mb-2 flex items-center gap-2 rounded-md border border-line bg-elevated px-2 py-1.5 text-2xs text-muted"
          >
            <span class="min-w-0 flex-1 truncate">
              Reviewing {gatedReview?.files[0]?.relPath} in the editor
            </span>
            <button
              class="shrink-0 rounded border border-line px-2 py-0.5 text-default hover:bg-hover"
              onclick={showChange}
            >
              Go to diff
            </button>
          </div>
        {:else if approvals[0] && questions}
          <!-- The call is a question, not an operation to approve: answering it is
             what lets it run, so the card asks rather than asking permission. -->
          {#key approvals[0].toolUseId}
            <AgentQuestion
              {questions}
              input={approvals[0].input}
              onAnswer={answerQuestion}
              onDecline={() => void decide(approvals[0].toolUseId, 'deny', 'no answer given')}
            />
          {/key}
        {:else if approvals[0]}
          <!-- An approval blocks the agent, so it replaces the composer until it is
             answered. Keyed so its selection state resets per request. -->
          {#key approvals[0].toolUseId}
            <AgentApproval
              item={approvals[0]}
              tool={catalog.toolNamed(approvals[0].name)}
              batch={gatedReview}
              onDecide={(result, reason) => void decide(approvals[0].toolUseId, result, reason)}
              onShowChange={showChange}
            />
          {/key}
        {:else if subagent}
          <!-- Nothing can be said here: the agent this session holds was run by
               another one, and ended when its tool call returned. -->
          <div
            class="flex items-center gap-2 rounded-md border border-line bg-elevated px-2 py-1.5 text-2xs text-dim"
          >
            <span class="min-w-0 flex-1">
              Run by another agent inside a tool call. Reply in the session that started it.
            </span>
            {#if parentSession}
              <button
                class="shrink-0 rounded border border-line px-2 py-0.5 text-default hover:bg-hover"
                onclick={() => selectSession(parentSession.id)}
              >
                Go there
              </button>
            {/if}
          </div>
        {:else}
          {#if activeId}
            <AgentComposer
              bind:this={composer}
              sessionId={activeId}
              {running}
              history={promptHistory}
              commandNames={catalog.completionNames()}
              onSend={send}
              onFocusChange={onComposerFocus}
              onInterrupt={interrupt}
              onCycleMode={cycleMode}
              onBack={showOverview}
            />
          {/if}

          {#if snapshot}
            <AgentControls
              harness={snapshot.harness}
              harnesses={catalog.harnesses}
              provider={snapshot.provider}
              model={snapshot.model}
              thinking={snapshot.thinkingLevel}
              {mode}
              {running}
              models={catalog.models}
              {reviewMode}
              {reviewPause}
              tokensLabel={contextLabel}
              contextTokens={snapshot.context.usedTokens}
              onPickHarness={pickHarness}
              onPickModel={pickModel}
              onRequestKey={requestCredential}
              onPickThinking={pickThinking}
              onPickMode={pickMode}
              onSetReview={setReviewSetting}
              onInterrupt={interrupt}
            />
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

{#if credentialRequest}
  <CredentialPrompt variables={credentialRequest} onClose={closeCredentialPrompt} />
{/if}
