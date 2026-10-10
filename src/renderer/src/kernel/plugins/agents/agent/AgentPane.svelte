<script lang="ts">
  // The agent pane.
  //
  // Sessions, transcripts, approvals and persistence belong to the main process,
  // which runs whichever harness the session names; this is a client for them,
  // plus the two things that are the pane's own business — which worktree a
  // session belongs to, and how its file changes get reviewed.

  import Icon from '@iconify/svelte'
  import Eye from 'phosphor-svelte/lib/Eye'
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { openFileInEditor, selectWorktree, store } from '../../../../lib/store.svelte'
  import { openLocationInEditor } from '../../../../lib/agents/locations'
  import { keymap } from '../../../../lib/keymap.svelte'
  import { settings } from '../../../../lib/settings.svelte'
  import { review } from '../../../../lib/review.svelte'
  import { catalog } from '../../../../lib/agents/catalog.svelte'
  import {
    defaultSessionHarness,
    defaultSessionThinking,
    defaultSessionGroveMode,
    GROVE_MODE_DESCRIPTION,
    rememberedModel,
    rememberModel
  } from '../../../../lib/agents/newSession'
  import {
    badgeOf,
    agentSessions,
    type LiveSession,
    type SessionBadge
  } from '../../../../lib/agents/sessions.svelte'
  import {
    compacting,
    pendingApprovals,
    toolCallOut,
    turnInFlightSince,
    visibleItems,
    waitingMessages,
    type ToolItem,
    type UserItem
  } from '../../../../lib/agents/transcript'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import {
    liveAgentIds,
    parentIdOf,
    sessionByAgentId,
    subagentOf,
    subagentSessions
  } from '../../../../lib/agents/sessionTree'
  import { displayOfCall, fileOfCall } from '../../../../lib/agents/tools'
  import { followStep } from '../../../../lib/agents/follow'
  import { questionsOf } from '../../../../lib/agents/questions'
  import { canEditMessage, editMessageEvents } from '../../../../lib/agents/editMessage'
  import { modeOf, nextMode, type AgentMode } from '../../../../lib/agents/modes'
  import { nextThinkingLevel } from '../../../../lib/agents/thinking'
  import { followsAfterScroll } from '../../../../lib/agents/scrollFollow'
  import type {
    ClientEventBody,
    CodeLocation,
    ConfirmationResult,
    HeldMessageDecision,
    LocationState,
    SessionMeta,
    SessionNote,
    ThinkingLevel,
    ToolInfo
  } from '../../../../lib/agents/types'
  import { saveNotes as saveSessionNotes } from '../../../../lib/agents/api'
  import AgentApproval from './AgentApproval.svelte'
  import AgentHeldMessage from './AgentHeldMessage.svelte'
  import AgentComposer from './AgentComposer.svelte'
  import AgentBackgroundCommands from './AgentBackgroundCommands.svelte'
  import AgentNotes from './AgentNotes.svelte'
  import AgentQuestion from './AgentQuestion.svelte'
  import AgentControls from './AgentControls.svelte'
  import AgentEditedFiles from './AgentEditedFiles.svelte'
  import AgentOverview from './AgentOverview.svelte'
  import AgentQueue from './AgentQueue.svelte'
  import AgentSessionTabs from './AgentSessionTabs.svelte'
  import AgentTranscript from './AgentTranscript.svelte'
  import AgentWorkingBar from './AgentWorkingBar.svelte'
  import CredentialPrompt from './CredentialPrompt.svelte'
  import EndpointEditor from './EndpointEditor.svelte'
  import PaneControls from '../../../../components/PaneControls.svelte'

  let { leafId }: { leafId: string } = $props()

  const worktree = $derived(store.selectedWorktree)
  const worktreePath = $derived(worktree?.path ?? '')

  const sessionList = $derived.by(() => {
    if (!worktreePath) return []
    return agentSessions.forWorktree(worktreePath)
  })
  const activeId = $derived(worktreePath ? agentSessions.resolveActive(worktreePath) : null)
  // Every session there is, not just this worktree's: a message quotes whoever
  // sent it, and a sender still running elsewhere is not a closed one.
  const liveAgents = $derived(liveAgentIds(agentSessions.list))
  const live = $derived<LiveSession | undefined>(
    activeId ? agentSessions.live[activeId] : undefined
  )
  const snapshot = $derived(live?.snapshot ?? null)

  // A session opened mid-command catches up on what its commands printed so far.
  $effect(() => {
    if (activeId) void shellOutputs.load(activeId)
  })

  // Reviews are recorded under the harness that made the changes, so the queue
  // for this session is looked up by the harness it is running on.
  const activeMeta = $derived(sessionList.find((session) => session.id === activeId))
  const harness = $derived.by(() => {
    if (snapshot) return snapshot.harness
    if (activeMeta) return activeMeta.harness
    return ''
  })

  const items = $derived.by(() => {
    if (!live) return []
    return visibleItems(live.transcript)
  })
  // What has already been said here, oldest first: the composer steps back
  // through the conversation itself, so history outlives the window it was
  // typed in the way the transcript does.
  const promptHistory = $derived.by(() => {
    const said = items.filter((item) => item.kind === 'user')
    return said.map((item) => item.text).filter((text) => text.trim().length > 0)
  })
  const approvals = $derived.by(() => {
    if (!live) return []
    return pendingApprovals(live.transcript)
  })
  // A card arriving mid-sentence would take the composer's place under the
  // user's fingers, so it waits until they have stopped typing for a while.
  const TYPING_HOLD_MS = 3000
  let typing = $state(false)
  let typingTimer: ReturnType<typeof setTimeout> | undefined

  /** Holds approval cards back until TYPING_HOLD_MS after the latest keystroke. */
  function onComposerKeystroke(): void {
    typing = true
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => {
      typing = false
    }, TYPING_HOLD_MS)
  }

  // The approval the card is showing, once the typing hold allows it.
  const shownApproval = $derived.by(() => {
    if (typing) return undefined
    return approvals[0]
  })
  // A parked call whose input is a set of questions is one, whatever the
  // harness named the tool.
  const questions = $derived(approvals[0] ? questionsOf(approvals[0].input) : null)
  const running = $derived(live?.transcript.status === 'running')
  const turnStart = $derived.by(() => {
    if (!live) return null
    return turnInFlightSince(live.transcript)
  })
  // The model is writing: the turn is running and not out on a tool call or a
  // compaction, each of which shows its own progress on its row.
  const writing = $derived(
    running && live !== undefined && !toolCallOut(live.transcript) && !compacting(live.transcript)
  )
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
  // Steered messages the agent has not taken up: already with the harness, so
  // shown but not removable. Queued ones are in `queued`, with a remove button.
  const steered = $derived.by(() => {
    if (!live) return []
    const queuedIds = new Set(queued.map((message) => message.id))
    return waitingMessages(live.transcript)
      .filter((item) => !queuedIds.has(item.eventId))
      .map((item) => ({ id: item.eventId, text: item.text }))
  })

  // Read straight off the session: the mode is stored there, so it is the same
  // answer in every window and after a restart.
  const mode = $derived(modeOf(snapshot))

  // The fleet view, reached by stepping left out of an empty composer.
  let overviewOpen = $state(false)
  let expandedTools = $state<Record<string, boolean>>({})
  let transcriptViewport = $state<HTMLDivElement>()
  let composer = $state<{ focus: () => boolean }>()
  let backgroundList = $state<{ focus: () => boolean }>()
  // The approval or question card standing in for the composer, while one is up.
  let promptCard = $state<{ focus: () => void }>()
  let rootEl = $state<HTMLDivElement>()
  let stickToBottom = $state(true)
  // The transcript's offset at its last scroll event, to tell a scroll up from content growing.
  let lastScrollTop = 0
  let disposeBindings: (() => void) | undefined

  // ── Settings ────────────────────────────────────────────────────

  const newSessionHarness = $derived(defaultSessionHarness())
  const rememberedThinking = $derived(defaultSessionThinking())
  const newSessionGroveMode = $derived(defaultSessionGroveMode())

  const reviewMode = $derived(settings.get<string>('workbench.reviewMode') ?? 'pre')

  function setReviewSetting(key: string, value: string | boolean): void {
    void settings.set(key, value, 'user')
  }

  // ── Review ──────────────────────────────────────────────────────

  // The batch raised for the approval on screen, if the review bridge staged one.
  const gatedReview = $derived(approvals[0] ? review.gatedFor(approvals[0].toolUseId) : null)
  const reviewIsOpen = $derived(gatedReview !== null && review.active?.id === gatedReview.id)
  const postReviews = $derived.by(() => {
    if (!worktreePath || !activeId) return []
    const queue = review.queueFor(worktreePath, harness, activeId)
    return queue.filter((batch) => batch.origin !== 'gated')
  })

  // ── Lifecycle ───────────────────────────────────────────────────

  onMount(() => {
    const unwatch = agentSessions.watch()
    void catalog.load()
    disposeBindings = registerBindings()
    return unwatch
  })

  onDestroy(() => {
    disposeBindings?.()
    clearTimeout(typingTimer)
    // Nothing shows this session once the pane is gone, so a turn ending in it
    // should be flagged like any other.
    agentSessions.unview(activeId)
  })

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
  // The viewport is watched too: a queue, an error or a taller composer taking
  // room below shrinks it without the content changing, and the newest lines
  // would sit hidden under whatever took their place.
  $effect(() => {
    const viewport = transcriptViewport
    const content = viewport?.firstElementChild
    if (!viewport || !content) return

    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(viewport)
    return () => observer.disconnect()
  })

  // A session switched in brings a whole transcript with it, which is a jump to
  // the bottom rather than a growth the observer would see. Having scrolled up
  // in the last session says nothing about this one.
  $effect(() => {
    void activeId
    untrack(() => {
      stickToBottom = true
      lastScrollTop = 0
      scrollToBottom()
    })
  })

  /** Scrolls the transcript to its newest output, unless the user scrolled away from it. */
  function scrollToBottom(): void {
    if (!stickToBottom || !transcriptViewport) return
    transcriptViewport.scrollTop = transcriptViewport.scrollHeight
  }

  /** Stops following when the user scrolls up away from the bottom, and resumes at it. */
  function onTranscriptScroll(): void {
    if (!transcriptViewport) return
    stickToBottom = followsAfterScroll(stickToBottom, lastScrollTop, transcriptViewport)
    lastScrollTop = transcriptViewport.scrollTop
  }

  // ── Sessions ────────────────────────────────────────────────────

  /**
   * A new session runs the harness the user last chose, and otherwise whichever
   * one the main process finds available, on the model last picked for it.
   */
  async function createSession(): Promise<void> {
    if (!worktreePath) return
    const model = rememberedModel(newSessionHarness)
    await agentSessions.create(worktreePath, {
      title: `Session ${sessionList.length + 1}`,
      harness: newSessionHarness || undefined,
      provider: model?.provider,
      model: model?.model,
      thinkingLevel: rememberedThinking,
      groveMode: newSessionGroveMode
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

  /** Answer a parked call; `input` is what it runs with when the user changed it. */
  function decide(
    toolUseId: string,
    result: ConfirmationResult,
    reason?: string,
    input?: unknown
  ): Promise<void> {
    if (!activeId) return Promise.resolve()
    return agentSessions.send(activeId, [
      { type: 'user.tool_confirmation', toolUseId, result, reason, input }
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

  /**
   * Withdraws the newest message still waiting for the agent and hands back its
   * text, for the composer to edit. Queued ones come first, being the newest; a
   * steered one is already with the harness, so main stops the turn to take it back.
   */
  function takeBackWaiting(): string | null {
    let newest: { id: string; text: string } | undefined = queued[queued.length - 1]
    if (!newest) newest = steered[steered.length - 1]
    if (!newest) return null
    unqueue(newest.id)
    return newest.text
  }

  function unqueue(messageId: string): void {
    if (!activeId) return
    void agentSessions.send(activeId, [{ type: 'user.unqueue', messageId }])
  }

  /** Answer an agent message held off this session; the wake gate in main carries it out. */
  function decideHeld(heldId: string, decision: HeldMessageDecision): void {
    if (!activeId) return
    void agentSessions.send(activeId, [{ type: 'user.decide_held_message', heldId, decision }])
  }

  // The session's harness can take its conversation back, so a sent message can
  // be edited and the conversation rerun from it.
  const rewinds = $derived(
    catalog.harnesses.find((entry) => entry.id === harness)?.capabilities.rewind === true
  )

  /** Whether a sent message offers to be edited. */
  function canEdit(item: UserItem): boolean {
    if (!live) return false
    return canEditMessage(item, live.transcript, rewinds)
  }

  /** Replace a sent message: the conversation goes back to before it, then the edit is sent. */
  function editMessage(item: UserItem, text: string): void {
    if (!live) return
    send(editMessageEvents(live.transcript, item, text))
  }

  /** Whether the to-do list above the composer is expanded. */
  let notesOpen = $state(true)

  /** Ctrl+T: shows or hides the to-do list, whether or not the composer has focus. */
  function toggleNotes(): void {
    notesOpen = !notesOpen
  }

  /** Save the notes list; it comes back through the stream like any change. */
  function saveNotes(notes: SessionNote[]): void {
    if (!activeId) return
    void saveSessionNotes(activeId, notes).catch((cause: unknown) =>
      store.setError(`Could not save the notes: ${(cause as Error).message}`)
    )
  }

  // ── Session settings ────────────────────────────────────────────

  /** Switch the session's model, and remember it for new sessions on the same harness. */
  function pickModel(provider: string, model: string): void {
    if (!activeId) return
    rememberModel(harness, { provider, model })
    void agentSessions.update(activeId, { provider, model })
  }

  // The provider and variables a route asked for, while its dialog is open.
  let credentialRequest = $state<{ provider: string; variables: string[] } | null>(null)

  function requestCredential(request: { provider: string; variables: string[] }): void {
    credentialRequest = request
  }

  /** A stored key changes which routes are ready, so the catalog is re-read. */
  function closeCredentialPrompt(stored: boolean): void {
    credentialRequest = null
    if (stored) void catalog.reload()
  }

  // Whether the editor for the user's own endpoints is open.
  let addingEndpoint = $state(false)

  /** A new endpoint brings its own models, so the catalog is re-read. */
  function closeEndpointEditor(saved: boolean): void {
    addingEndpoint = false
    if (saved) void catalog.reload()
  }

  /**
   * Pick the harness for a session that has not started yet, and for the ones
   * started from now on. A session another harness has already answered on
   * keeps it — the main process refuses the change either way. The session
   * moves to the model last picked on the new harness, since the old one's
   * model id means nothing there.
   */
  function pickHarness(next: string): void {
    void settings.set('workbench.agentHarness', next, 'user')
    if (!activeId || next === harness) return
    if (snapshot?.started) return
    const model = rememberedModel(next)
    if (!model) {
      void agentSessions.update(activeId, { harness: next })
      return
    }
    void agentSessions.update(activeId, { harness: next, ...model })
  }

  /**
   * Switch grove mode for a session that has not started yet, and for the ones
   * started from now on. Like the harness, a started session keeps what it
   * started with.
   */
  function pickGroveMode(groveMode: boolean): void {
    void settings.set('workbench.agentGroveMode', groveMode, 'user')
    if (!activeId || snapshot?.started) return
    void agentSessions.update(activeId, { groveMode })
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

  // A command running in the session — the agent's or a `!` one — which
  // Ctrl+B can send to the background.
  const commandRunning = $derived.by(() => {
    if (!activeId) return false
    return Object.values(shellOutputs.forSession(activeId)).some((command) => command.running)
  })

  /**
   * Sends the session's running commands to the background: the agent gets its
   * call back, and a `!` command runs past its time limit.
   */
  function backgroundShell(): void {
    if (activeId) shellOutputs.background(activeId)
  }

  function cycleThinking(): void {
    const current = snapshot?.thinkingLevel ?? rememberedThinking
    pickThinking(nextThinkingLevel(current))
  }

  /**
   * Put the session into a mode.
   *
   * One patch, because the mode is stored on the session — the main process
   * answers approvals from it, and the harness is told when plan mode needs it
   * to withhold tools.
   */
  function pickMode(next: AgentMode): void {
    if (!activeId) return
    void agentSessions.setMode(activeId, next)
  }

  // ── Editor handoff ──────────────────────────────────────────────

  /** Tool paths are absolute or workspace-relative; the editor wants absolute. */
  function openFile(path: string, options: { focus?: boolean } = {}): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    const absolute = path.startsWith('/') ? path : `${worktreePath}/${path}`
    openFileInEditor(worktreeId, absolute, options)
  }

  /** Open a place an agent pointed at, as it was found in the code now. */
  function openLocation(location: CodeLocation, state: LocationState = 'current'): void {
    openLocationInEditor(worktreePath, location, state)
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

  // ── Edited files ────────────────────────────────────────────────

  let editedFilesOpen = $state(false)

  // The session's last event; the edited files are read again when it moves.
  const transcriptSeq = $derived.by(() => {
    if (!live) return 0
    return live.transcript.lastSeq
  })

  function toggleEditedFiles(): void {
    if (!activeId) return
    editedFilesOpen = !editedFilesOpen
  }

  // Calls already followed, and the session they belong to. A call that was on
  // screen before follow mode came on is history, not something to replay into
  // the editor.
  let followedCalls = new Set<string>()
  let followedSession: string | null = null

  /** The ids of every tool call in the transcript on screen. */
  function callIdsOnScreen(): Set<string> {
    const ids: string[] = []
    for (const item of items) {
      if (item.kind === 'tool') ids.push(item.toolUseId)
    }
    return new Set(ids)
  }

  function displayOf(call: ToolItem): ToolInfo['display'] {
    return displayOfCall(catalog.tools, call)
  }

  /**
   * Opens the file of every call whose file is newly known; only ever moves
   * forward. A call still streaming its arguments is looked at again later.
   */
  // The set is replaced rather than added to: it is plain bookkeeping, not state,
  // and the effect below both reads and writes it.
  function followNewCalls(): void {
    const step = followStep(items, followedCalls, (call) =>
      fileOfCall(displayOf(call), call.editedInput ?? call.input, worktreePath)
    )
    followedCalls = step.followed
    // The agent opened these, not the user: show them, but leave focus where the
    // user is, which is often mid-sentence in the composer.
    for (const path of step.open) openFile(path, { focus: false })
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

  /** Moves the keyboard to the background tasks under the composer; false when there are none. */
  function focusBackgroundList(): boolean {
    if (!backgroundList) return false
    return backgroundList.focus()
  }

  // ── Focus ───────────────────────────────────────────────────────
  //
  // However the pane gains focus, the keyboard goes where typing goes: the card
  // the agent is waiting on, else the composer. Pane navigation, focus-follows-
  // mouse and focus handed back after a dialog come through the delegate; a
  // click from another pane lands on the pane's own surface and moves on from
  // there.

  /** Focuses the card the agent is waiting on, else the composer; false if neither can take it. */
  function focusPromptTarget(): boolean {
    if (overviewOpen) return false
    if (promptCard) {
      promptCard.focus()
      return true
    }
    if (!composer) return false
    return composer.focus()
  }

  $effect(() => keymap.registerPaneFocus(leafId, focusPromptTarget))

  $effect(() => {
    const leafEl = rootEl?.closest<HTMLElement>('[data-leaf]')
    if (!leafEl) return
    return steerSurfaceFocus(leafEl)
  })

  /**
   * Moves focus that lands on the pane's surface — a click on the transcript —
   * on to the composer, unless the press dragged out a selection, which keeps
   * it. Returns the teardown.
   */
  function steerSurfaceFocus(leafEl: HTMLElement): () => void {
    let pressed = false
    const onPointerDown = (): void => {
      pressed = true
    }
    const onPointerUp = (): void => {
      pressed = false
    }
    const afterPress = (): void => {
      if (!window.getSelection()?.isCollapsed) return
      focusPromptTarget()
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (!landedOnSurface(event)) return
      if (pressed) {
        window.addEventListener('pointerup', afterPress, { once: true })
        return
      }
      focusPromptTarget()
    }
    leafEl.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    leafEl.addEventListener('focusin', onFocusIn)
    return () => {
      leafEl.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointerup', afterPress)
      leafEl.removeEventListener('focusin', onFocusIn)
    }
  }

  /** Whether focus landed on an element wrapping this pane rather than on a control inside it. */
  function landedOnSurface(event: FocusEvent): boolean {
    const target = event.target
    if (!(target instanceof HTMLElement) || !rootEl) return false
    return target.contains(rootEl)
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
        id: `agent.editedFiles:${leafId}`,
        keys: 'e',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Files this session edited',
        run: toggleEditedFiles
      },
      {
        id: `agent.cycleMode:${leafId}`,
        keys: 'shift+tab',
        context: leafId,
        group: 'Agent',
        description: 'Cycle permission mode',
        // A card up for an answer uses Shift+Tab to step back through its choices.
        when: () => shownApproval === undefined,
        run: cycleMode
      },
      {
        id: `agent.backgroundShell:${leafId}`,
        keys: 'ctrl+b',
        context: leafId,
        group: 'Agent',
        description: 'Send running command to background',
        when: () => commandRunning,
        run: backgroundShell
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
        id: `agent.toggleNotes:${leafId}`,
        keys: 'ctrl+t',
        context: leafId,
        group: 'Agent',
        description: 'Show or hide the to-do list',
        run: toggleNotes
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
      // Not tied to normal mode: the composer holds focus whenever the pane does,
      // and Alt+H/L type nothing there, so they switch sessions from it too.
      {
        id: `agent.prevSession:${leafId}`,
        keys: 'alt+h',
        context: leafId,
        group: 'Agent',
        description: 'Previous session',
        run: () => cycleSession(-1)
      },
      {
        id: `agent.nextSession:${leafId}`,
        keys: 'alt+l',
        context: leafId,
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

  // Cost so far, as the harness reports it; hidden while nothing has been spent.
  const costLabel = $derived.by(() => {
    if (!snapshot) return ''
    if (snapshot.cost <= 0) return ''
    return `$${snapshot.cost.toFixed(2)}`
  })

  const errorText = $derived(live?.error || agentSessions.serverError || catalog.error)
</script>

<div bind:this={rootEl} class="relative flex h-full flex-col">
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
        class="mr-1.5 flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs"
        class:bg-elevated={following}
        class:text-blue={following}
        class:text-dim={!following}
        class:hover:bg-hover={!following}
        class:hover:text-default={!following}
        title="Follow mode: open every file the agent reads or writes (f)"
        aria-pressed={following}
        onclick={toggleFollow}
      >
        <Eye width="13" height="13" weight={following ? 'fill' : 'regular'} />
        Follow
      </button>
      <button
        class="mr-1.5 flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs disabled:opacity-50"
        class:bg-elevated={editedFilesOpen}
        class:text-blue={editedFilesOpen}
        class:text-dim={!editedFilesOpen}
        class:enabled:hover:bg-hover={!editedFilesOpen}
        class:enabled:hover:text-default={!editedFilesOpen}
        title="Files this session edited (e)"
        aria-expanded={editedFilesOpen}
        disabled={!activeId}
        onpointerdown={(event) => event.stopPropagation()}
        onclick={toggleEditedFiles}
      >
        <PencilSimple width="13" height="13" />
        Edits
      </button>
      <PaneControls class="mr-1.5" />
    </div>

    {#if editedFilesOpen && activeId && store.selectedWorktreeId}
      <AgentEditedFiles
        sessionId={activeId}
        worktreeId={store.selectedWorktreeId}
        {worktreePath}
        revision={transcriptSeq}
        onClose={() => (editedFilesOpen = false)}
      />
    {/if}

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
        turnInFlightSince={turnStart}
        toggleTool={(id) => (expandedTools = { ...expandedTools, [id]: !expandedTools[id] })}
        onOpenFile={openFile}
        onOpenLocation={openLocation}
        onOpenAgent={openAgent}
        onOpenSession={selectSession}
        subagentSessions={agentCallSessions}
        liveAgentIds={liveAgents}
        {canEdit}
        onEditMessage={editMessage}
        bind:viewport={transcriptViewport}
        onscroll={onTranscriptScroll}
      >
        {#snippet footer()}
          {#if writing}
            <AgentWorkingBar tokensLabel={contextLabel} />
          {/if}
        {/snippet}
      </AgentTranscript>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3">
        <p class="text-xs text-dim">No agent session in this worktree.</p>
        <!-- Pick the harness before starting: switching afterwards restarts the
             conversation, since the new runtime knows nothing of the old one.
             The row wraps in a narrow pane rather than running off its sides. -->
        <div class="flex max-w-full flex-wrap items-center justify-center gap-1">
          {#each catalog.harnesses as entry (entry.id)}
            <button
              class="flex items-center gap-1.5 whitespace-nowrap rounded border border-line px-2 py-1 text-2xs hover:bg-hover disabled:opacity-50"
              class:text-default={entry.id === newSessionHarness}
              class:text-dim={entry.id !== newSessionHarness}
              disabled={!entry.available}
              title={entry.detail ?? entry.description}
              onclick={() => pickHarness(entry.id)}
            >
              <Icon icon={entry.icon} class="size-3.5 shrink-0" />
              {entry.label}
            </button>
          {/each}
          <button
            class="flex items-center gap-1.5 whitespace-nowrap rounded border border-line px-2 py-1 text-2xs hover:bg-hover"
            class:text-default={newSessionGroveMode}
            class:text-dim={!newSessionGroveMode}
            title={GROVE_MODE_DESCRIPTION}
            aria-pressed={newSessionGroveMode}
            onclick={() => pickGroveMode(!newSessionGroveMode)}
          >
            <Icon icon="grove:grove" class="size-3.5 shrink-0" />
            Grove mode
          </button>
        </div>
        <button
          class="rounded-md bg-action px-3 py-1 text-xs text-action-fg"
          onclick={createSession}
        >
          New session
        </button>
      </div>
    {/if}

    {#if steered.length > 0 && !overviewOpen}
      <AgentQueue messages={steered} />
    {/if}
    {#if queued.length > 0 && !overviewOpen}
      <AgentQueue messages={queued} onCancel={unqueue} />
    {/if}

    {#if !overviewOpen}
      <div class="relative shrink-0 p-2">
        {#if live}
          {#each live.transcript.held as held (held.heldId)}
            <AgentHeldMessage {held} onDecide={(decision) => decideHeld(held.heldId, decision)} />
          {/each}
        {/if}
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

        {#if shownApproval && reviewIsOpen}
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
        {:else if shownApproval && questions}
          <!-- The call is a question, not an operation to approve: answering it is
             what lets it run, so the card asks rather than asking permission. -->
          {#key shownApproval.toolUseId}
            <AgentQuestion
              bind:this={promptCard}
              {questions}
              input={shownApproval.input}
              onAnswer={answerQuestion}
              onDecline={() => void decide(shownApproval.toolUseId, 'deny', 'no answer given')}
            />
          {/key}
        {:else if shownApproval}
          <!-- An approval blocks the agent, so it replaces the composer until it is
             answered. Keyed so its selection state resets per request. -->
          {#key shownApproval.toolUseId}
            <AgentApproval
              bind:this={promptCard}
              item={shownApproval}
              tool={catalog.toolNamed(shownApproval.name)}
              batch={gatedReview}
              onDecide={(result, reason, input) =>
                void decide(shownApproval.toolUseId, result, reason, input)}
              onShowChange={showChange}
              onRequestKey={requestCredential}
              onAddEndpoint={() => (addingEndpoint = true)}
            />
          {/key}
        {/if}

        {#if subagent && shownApproval}
          <!-- The card above stands in for the notice. -->
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
          <!-- Kept mounted while an approval or question stands in for it, so the
               draft being written survives the card. -->
          {#if activeId}
            <AgentComposer
              bind:this={composer}
              hidden={shownApproval !== undefined}
              onKeystroke={onComposerKeystroke}
              sessionId={activeId}
              {running}
              history={promptHistory}
              commandNames={catalog.completionNames()}
              onSend={send}
              onFocusChange={onComposerFocus}
              onInterrupt={interrupt}
              onCycleMode={cycleMode}
              onBack={showOverview}
              onLeaveDown={focusBackgroundList}
              onTakeBack={takeBackWaiting}
              header={live ? notesHeader : undefined}
            />
          {/if}

          {#if activeId && live && !shownApproval}
            <AgentBackgroundCommands
              bind:this={backgroundList}
              sessionId={activeId}
              items={live.transcript.items}
              onLeave={focusComposer}
            />
          {/if}

          {#if snapshot && !shownApproval}
            <AgentControls
              harness={snapshot.harness}
              harnesses={catalog.harnesses}
              started={snapshot.started}
              groveMode={snapshot.groveMode}
              provider={snapshot.provider}
              model={snapshot.model}
              thinking={snapshot.thinkingLevel}
              {mode}
              {running}
              models={catalog.models}
              {reviewMode}
              tokensLabel={contextLabel}
              {costLabel}
              contextTokens={snapshot.context.usedTokens}
              onPickHarness={pickHarness}
              onPickGroveMode={pickGroveMode}
              onPickModel={pickModel}
              onRequestKey={requestCredential}
              onAddEndpoint={() => (addingEndpoint = true)}
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

{#if addingEndpoint}
  <EndpointEditor onClose={closeEndpointEditor} />
{/if}

{#if credentialRequest}
  <CredentialPrompt
    provider={credentialRequest.provider}
    variables={credentialRequest.variables}
    onClose={closeCredentialPrompt}
  />
{/if}

<!-- The notes list, drawn as the top of the composer rather than a card of its own. -->
{#snippet notesHeader()}
  {#if live}
    <AgentNotes
      notes={live.transcript.notes}
      tasks={live.transcript.tasks}
      onSave={saveNotes}
      bind:open={notesOpen}
    />
  {/if}
{/snippet}
