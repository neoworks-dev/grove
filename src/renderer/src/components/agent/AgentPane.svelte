<script lang="ts">
  // The agent pane.
  //
  // Sessions, transcripts, approvals and persistence all belong to the embedded
  // nib server; this is a client for them, plus the two things that are grove's
  // own business — which worktree a session belongs to, and how its file changes
  // get reviewed.

  import { onDestroy, onMount } from 'svelte'
  import { openFileInEditor, store } from '../../lib/store.svelte'
  import { keymap } from '../../lib/keymap.svelte'
  import { settings } from '../../lib/settings.svelte'
  import { review } from '../../lib/review.svelte'
  import { catalog } from '../../lib/nib/catalog.svelte'
  import {
    badgeOf,
    nibSessions,
    type LiveSession,
    type SessionBadge
  } from '../../lib/nib/sessions.svelte'
  import { pendingApprovals, visibleItems } from '../../lib/nib/transcript'
  import { activeToolsFor, autoDecisionFor, modeOf, type AgentMode } from '../../lib/nib/modes'
  import type {
    ClientEventBody,
    ConfirmationResult,
    SessionMeta,
    ThinkingLevel
  } from '../../lib/nib/types'
  import AgentApproval from './AgentApproval.svelte'
  import AgentComposer from './AgentComposer.svelte'
  import AgentControls from './AgentControls.svelte'
  import AgentQueue from './AgentQueue.svelte'
  import AgentSessionTabs from './AgentSessionTabs.svelte'
  import AgentTranscript from './AgentTranscript.svelte'
  import AgentWorkingBar from './AgentWorkingBar.svelte'

  // The agent this pane speaks for, in grove's review vocabulary. One adapter now,
  // so it is a constant rather than a choice.
  const AGENT = 'nib'

  let { leafId }: { leafId: string } = $props()

  const worktree = $derived(store.selectedWorktree)
  const worktreePath = $derived(worktree?.path ?? '')

  const sessionList = $derived(worktreePath ? nibSessions.forWorktree(worktreePath) : [])
  const activeId = $derived(worktreePath ? nibSessions.resolveActive(worktreePath) : null)
  const live = $derived<LiveSession | undefined>(activeId ? nibSessions.live[activeId] : undefined)
  const snapshot = $derived(live?.snapshot ?? null)

  const items = $derived(live ? visibleItems(live.transcript) : [])
  const approvals = $derived(live ? pendingApprovals(live.transcript) : [])
  const running = $derived(live?.transcript.status === 'running')
  const queued = $derived(snapshot?.queued ?? [])

  // Bypass is deliberately not persisted: "do whatever you like" should not
  // outlive the sitting it was granted in.
  let bypassing = $state(false)
  const mode = $derived(modeOf(snapshot, bypassing))

  let expandedTools = $state<Record<string, boolean>>({})
  let transcriptViewport = $state<HTMLDivElement>()
  let composer = $state<{ focus: () => void }>()
  let stickToBottom = $state(true)
  let disposeBindings: (() => void) | undefined

  // ── Settings ────────────────────────────────────────────────────

  const reviewMode = $derived(settings.get<string>('workbench.reviewMode') ?? 'pre')
  const reviewPause = $derived(settings.get<boolean>('workbench.reviewPause') ?? false)
  const reviewDiffLayout = $derived(
    settings.get<string>('workbench.reviewDiffLayout') ?? 'side-by-side'
  )

  function setReviewSetting(key: string, value: string | boolean): void {
    void settings.set(key, value, 'user')
  }

  // ── Review ──────────────────────────────────────────────────────

  // The batch raised for the approval on screen, if the review bridge staged one.
  const gatedReview = $derived(approvals[0] ? review.gatedFor(approvals[0].toolUseId) : null)
  const reviewIsOpen = $derived(gatedReview !== null && review.active?.id === gatedReview.id)
  const postReviews = $derived(
    worktreePath && activeId
      ? review.queueFor(worktreePath, AGENT, activeId).filter((batch) => batch.origin !== 'gated')
      : []
  )

  // ── Lifecycle ───────────────────────────────────────────────────

  onMount(() => {
    const unwatch = nibSessions.watch()
    void catalog.load()
    disposeBindings = registerBindings()
    return unwatch
  })

  onDestroy(() => disposeBindings?.())

  // Follow the selection: open a stream for the session on screen, and tell the
  // store which one it is so its unread count clears.
  $effect(() => {
    const id = activeId
    nibSessions.view(id)
    if (id) void nibSessions.open(id)
  })

  // Answer approvals the current mode says not to bother the user with.
  $effect(() => {
    if (!activeId) return
    for (const approval of approvals) {
      const decision = autoDecisionFor(mode, approval.name, reviewMode)
      if (decision) void decide(approval.toolUseId, decision)
    }
  })

  // Keep the newest output in view unless the user has scrolled away from it.
  $effect(() => {
    void items.length
    if (!stickToBottom || !transcriptViewport) return
    queueMicrotask(() => {
      if (transcriptViewport) transcriptViewport.scrollTop = transcriptViewport.scrollHeight
    })
  })

  function onTranscriptScroll(): void {
    if (!transcriptViewport) return
    const distance =
      transcriptViewport.scrollHeight -
      transcriptViewport.scrollTop -
      transcriptViewport.clientHeight
    stickToBottom = distance < 40
  }

  // ── Sessions ────────────────────────────────────────────────────

  async function createSession(): Promise<void> {
    if (!worktreePath) return
    await nibSessions.create(worktreePath, { title: `Session ${sessionList.length + 1}` })
  }

  async function closeSession(sessionId: string, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    if (!worktreePath) return
    await nibSessions.remove(worktreePath, sessionId)
  }

  function selectSession(sessionId: string): void {
    if (!worktreePath) return
    nibSessions.setActive(worktreePath, sessionId)
  }

  function cycleSession(step: number): void {
    if (sessionList.length === 0) return
    const current = sessionList.findIndex((session) => session.id === activeId)
    const next = (current + step + sessionList.length) % sessionList.length
    selectSession(sessionList[next].id)
  }

  function badgeFor(session: SessionMeta): SessionBadge {
    return badgeOf(session, nibSessions.live[session.id])
  }

  function unreadFor(session: SessionMeta): number {
    return nibSessions.live[session.id]?.unread ?? 0
  }

  // ── Sending ─────────────────────────────────────────────────────

  function send(events: ClientEventBody[]): void {
    if (!activeId) return
    void nibSessions.send(activeId, events)
    stickToBottom = true
  }

  function decide(toolUseId: string, result: ConfirmationResult, reason?: string): Promise<void> {
    if (!activeId) return Promise.resolve()
    return nibSessions.send(activeId, [
      { type: 'user.tool_confirmation', toolUseId, result, reason }
    ])
  }

  function interrupt(): void {
    if (!activeId) return
    void nibSessions.send(activeId, [{ type: 'user.interrupt' }])
  }

  function unqueue(messageId: string): void {
    if (!activeId) return
    void nibSessions.send(activeId, [{ type: 'user.unqueue', messageId }])
  }

  // ── Session settings ────────────────────────────────────────────

  function pickModel(provider: string, model: string): void {
    if (!activeId) return
    void nibSessions.update(activeId, { provider, model })
  }

  function pickThinking(thinkingLevel: ThinkingLevel): void {
    if (!activeId) return
    void nibSessions.update(activeId, { thinkingLevel })
  }

  /**
   * Switching mode is a session change, not a local flag — except for bypass,
   * which has no server-side representation by design.
   */
  function pickMode(next: AgentMode): void {
    bypassing = next === 'bypass'
    if (!activeId || next === 'bypass') return
    const allTools = catalog.tools.map((tool) => tool.name)
    void nibSessions.update(activeId, { activeTools: activeToolsFor(next, allTools) })
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

  const errorText = $derived(live?.error || nibSessions.serverError || catalog.error)
</script>

<div class="flex h-full flex-col">
  {#if !worktree}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <AgentSessionTabs
      sessions={sessionList}
      {activeId}
      {badgeFor}
      {unreadFor}
      onSelect={selectSession}
      onClose={closeSession}
      onCreate={createSession}
    />

    {#if errorText}
      <div class="shrink-0 border-b border-red/30 bg-red-soft px-3 py-1.5 text-2xs text-red">
        {errorText}
      </div>
    {/if}

    {#if activeId && live}
      <AgentTranscript
        sessionId={activeId}
        {items}
        tools={catalog.tools}
        {expandedTools}
        toggleTool={(id) => (expandedTools = { ...expandedTools, [id]: !expandedTools[id] })}
        onOpenFile={openFile}
        bind:viewport={transcriptViewport}
        onscroll={onTranscriptScroll}
      />
    {:else}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3">
        <p class="text-xs text-dim">No agent session in this worktree.</p>
        <button
          class="rounded-md bg-action px-3 py-1 text-xs text-action-fg"
          onclick={createSession}
        >
          New session
        </button>
      </div>
    {/if}

    {#if running}
      <AgentWorkingBar message="Working…" tokensLabel={contextLabel} />
    {/if}

    {#if queued.length > 0}
      <AgentQueue messages={queued} onCancel={unqueue} />
    {/if}

    <div class="relative shrink-0 border-t border-line p-3">
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
      {:else if approvals[0]}
        <!-- An approval blocks the agent, so it replaces the composer until it is
             answered. Keyed so its selection state resets per request. -->
        {#key approvals[0].toolUseId}
          <AgentApproval
            item={approvals[0]}
            tool={catalog.toolNamed(approvals[0].name)}
            hasDiff={gatedReview !== null}
            onDecide={(result, reason) => void decide(approvals[0].toolUseId, result, reason)}
            onShowChange={showChange}
          />
        {/key}
      {:else}
        {#if activeId}
          <AgentComposer
            bind:this={composer}
            sessionId={activeId}
            {running}
            commandNames={catalog.completionNames()}
            onSend={send}
            onFocusChange={onComposerFocus}
          />
        {/if}

        {#if snapshot}
          <AgentControls
            provider={snapshot.provider}
            model={snapshot.model}
            thinking={snapshot.thinkingLevel}
            {mode}
            {running}
            providers={catalog.providers}
            {reviewMode}
            {reviewPause}
            {reviewDiffLayout}
            tokensLabel={contextLabel}
            onPickModel={pickModel}
            onPickThinking={pickThinking}
            onPickMode={pickMode}
            onSetReview={setReviewSetting}
            onInterrupt={interrupt}
          />
        {/if}
      {/if}
    </div>
  {/if}
</div>
