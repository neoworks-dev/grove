<script lang="ts">
  // The agents this conversation is running, between the prompt and its controls: the
  // session itself first, then one row for each agent it started that is still at work
  // or ended badly. Plain on purpose; the agent pane's footer gets a design pass of
  // its own.
  //
  // ArrowDown from the prompt lands here. The arrows move through the rows, Enter opens
  // one, x stops a running agent or clears a finished one, and Escape or ArrowUp from
  // the top goes back to the prompt. x on the session itself, or on the agent being
  // looked at, is a letter for the prompt instead.

  import { onDestroy, untrack } from 'svelte'
  import { keyDispatch, KeyPriority } from '../../../../lib/keyDispatch'
  import { subagentOf, sessionFamilies } from '../../../../lib/agents/sessionTree'
  import { agentSessions, badgeOf } from '../../../../lib/agents/sessions.svelte'
  import {
    SETTLED_VISIBLE_MS,
    harnessRunStateOf,
    isActiveState,
    isRowListed,
    movedSelection,
    panelStateOf,
    windowRows,
    type PanelRow,
    type PanelState
  } from '../../../../lib/agents/subagentPanel'
  import type { IdleReason, SessionMeta } from '../../../../lib/agents/types'

  let {
    sessions,
    activeId,
    onOpen,
    onStop,
    onLeave,
    onTypeIntoPrompt
  }: {
    /** The sessions in this worktree. */
    sessions: SessionMeta[]
    activeId: string | null
    /** Show one session's conversation. */
    onOpen: (sessionId: string) => void
    /** Stop a running agent. */
    onStop: (row: PanelRow) => void
    /** Hand the keyboard back to the prompt. */
    onLeave: () => void
    /** Type a character into the prompt, for a key the panel has no use for on this row. */
    onTypeIntoPrompt: (text: string) => void
  } = $props()

  /** The family the session on screen belongs to, the one the user started first. */
  const family = $derived.by(() => {
    const found = sessionFamilies(sessions).find((members) =>
      members.some((member) => member.session.id === activeId)
    )
    if (found === undefined) return []
    return found
  })

  /** Every member of the family as a row, with what it is doing now. */
  const candidates = $derived.by(() => {
    const members = family.map((member, index): PanelRow => {
      const live = agentSessions.live[member.session.id]
      let status = member.session.status
      let stopReason: IdleReason | null = null
      if (member.session.stopReason !== undefined) stopReason = member.session.stopReason
      if (live !== undefined) {
        status = live.transcript.status
        stopReason = live.transcript.stopReason
      }
      return {
        sessionId: member.session.id,
        title: titleOf(member.session),
        isMain: index === 0,
        harnessRun: subagentOf(member.session) !== null,
        state: panelStateOf(status, stopReason, badgeOf(member.session, live))
      }
    })
    return members.map((row, index) => settleHarnessRun(row, members[0], family[index].session))
  })

  /** When the turn the session user started is on began, or an empty string before the first. */
  const mainTurnStartedAt = $derived.by(() => {
    if (family.length === 0) return ''
    const live = agentSessions.live[family[0].session.id]
    if (live === undefined) return ''
    const startedAt = live.transcript.createdAt.get(live.transcript.turnStartSeq)
    if (startedAt === undefined) return ''
    return startedAt
  })

  /** A harness-run agent's row, taking its state from the session that started it while it has none of its own. */
  function settleHarnessRun(row: PanelRow, main: PanelRow, session: SessionMeta): PanelRow {
    if (!row.harnessRun) return row
    const startedInCurrentTurn = session.createdAt >= mainTurnStartedAt
    return { ...row, state: harnessRunStateOf(row.state, main.state, startedInCurrentTurn) }
  }

  /** A session's name for its row. */
  function titleOf(session: SessionMeta): string {
    if (session.title.trim().length > 0) return session.title
    return session.model || 'Session'
  }

  // When each agent got into the state it is in, for the ones that stay listed a while.
  let since = $state<Record<string, { state: PanelState; at: number }>>({})
  let dismissed = $state<Record<string, boolean>>({})
  let now = $state(Date.now())
  // Set when an agent finishes well: the row is gone at once, so this says where it went.
  let finishedHintUntil = $state(0)

  // Notes the moment each agent changes state, which is what the 30 seconds run from.
  $effect(() => {
    const current = candidates.map((row) => ({ id: row.sessionId, state: row.state }))
    untrack(() => recordStates(current))
  })

  /** Remembers when each agent last changed state, and raises the finished hint for one that ended well. */
  function recordStates(current: { id: string; state: PanelState }[]): void {
    const next = { ...since }
    const moment = Date.now()
    let changed = false
    for (const entry of current) {
      const known = next[entry.id]
      if (known !== undefined && known.state === entry.state) continue
      if (known !== undefined && isActiveState(known.state) && entry.state === 'finished') {
        finishedHintUntil = moment + SETTLED_VISIBLE_MS
      }
      next[entry.id] = { state: entry.state, at: moment }
      changed = true
    }
    if (changed) since = next
  }

  // The clock that takes a failed or idle agent off the list, ticking only while there is something to time.
  const ticker = setInterval(() => {
    now = Date.now()
  }, 1000)
  onDestroy(() => clearInterval(ticker))

  /** The settled time of a row, if it has been seen. */
  function settledAtOf(sessionId: string): number | undefined {
    const known = since[sessionId]
    if (known === undefined) return undefined
    return known.at
  }

  /** The rows on the list: the session itself, then each agent that is still listed. */
  const rows = $derived.by(() => {
    const listed: PanelRow[] = []
    for (const row of candidates) {
      if (row.isMain) {
        listed.push(row)
        continue
      }
      const settledAt = settledAtOf(row.sessionId)
      if (isRowListed(row.state, settledAt, now, dismissed[row.sessionId] === true)) {
        listed.push(row)
      }
    }
    return listed
  })

  const hasAgents = $derived(rows.length > 1)
  const hintVisible = $derived(now < finishedHintUntil)

  let rootEl = $state<HTMLDivElement>()
  let focused = $state(false)
  // The row under the cursor, as an index into `rows`.
  let selected = $state(0)

  // The list can shrink under the cursor.
  $effect(() => {
    if (selected > rows.length - 1) selected = Math.max(0, rows.length - 1)
  })

  const view = $derived(windowRows(rows, selected))

  /** Notes focus arriving, starting the cursor on the row whose conversation is on screen. */
  function onFocusIn(): void {
    if (!focused) {
      const viewed = rows.findIndex((row) => row.sessionId === activeId)
      if (viewed >= 0) selected = viewed
    }
    focused = true
  }

  /**
   * Notes focus leaving the panel, unless it only moved between its own rows. When
   * it left because the last agent ended and the panel went away under it, the
   * keyboard goes back to the prompt rather than nowhere.
   */
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && rootEl?.contains(next)) return
    focused = false
    if (next === null && !hasAgents) queueMicrotask(onLeave)
  }

  /** Moves the cursor, or leaves for the prompt from the top row. */
  function moveUp(): void {
    if (selected === 0) {
      onLeave()
      return
    }
    selected = movedSelection(selected, -1, rows.length)
  }

  /** Moves the cursor down a row. */
  function moveDown(): void {
    selected = movedSelection(selected, 1, rows.length)
  }

  /** Shows the conversation of the row under the cursor. */
  function openSelected(): void {
    const row = rows[selected]
    if (row === undefined) return
    if (row.sessionId === activeId) {
      onLeave()
      return
    }
    onOpen(row.sessionId)
  }

  /** x: stops a running agent, clears a finished one, and types into the prompt on the session itself or the one being looked at. */
  function removeSelected(): void {
    const row = rows[selected]
    if (row === undefined) return
    if (row.isMain || row.sessionId === activeId) {
      onTypeIntoPrompt('x')
      return
    }
    if (isActiveState(row.state)) {
      onStop(row)
      return
    }
    dismissed = { ...dismissed, [row.sessionId]: true }
  }

  const KEY_ACTIONS: Record<string, () => void> = {
    ArrowUp: moveUp,
    ArrowDown: moveDown,
    Enter: openSelected,
    Escape: () => onLeave(),
    x: removeSelected
  }

  /**
   * Claims the panel's keys while it has focus. Through the dispatcher rather than an
   * element listener: the pane's bare-key bindings run in the capture phase and would
   * take x and the rest first.
   */
  function onKey(event: KeyboardEvent): boolean {
    if (!focused || event.ctrlKey || event.altKey || event.metaKey) return false
    const action = KEY_ACTIONS[event.key]
    if (!action) return false
    event.preventDefault()
    event.stopPropagation()
    action()
    return true
  }

  const unsubscribe = keyDispatch.subscribe(KeyPriority.menu, onKey)
  onDestroy(unsubscribe)

  const STATE_LABEL: Record<PanelState, string> = {
    running: 'running',
    waiting: 'needs you',
    idle: 'idle',
    finished: 'finished',
    failed: 'failed',
    stopped: 'stopped'
  }

  const STATE_COLOR: Record<PanelState, string> = {
    running: 'text-green',
    waiting: 'text-amber',
    idle: 'text-dim',
    finished: 'text-dim',
    failed: 'text-red',
    stopped: 'text-dim'
  }
</script>

{#if hasAgents}
  <div
    bind:this={rootEl}
    data-footer-item="own-keys"
    data-testid="subagent-panel"
    class="mb-1.5 mt-1.5 rounded-md border border-line bg-elevated text-2xs text-muted outline-none focus:border-accent"
    tabindex="-1"
    role="listbox"
    aria-label="Agents"
    onfocusin={onFocusIn}
    onfocusout={onFocusOut}
  >
    {#each view.rows as row, offset (row.sessionId)}
      <div
        class="flex items-center gap-2 px-2 py-0.5"
        class:bg-hover={focused && selected === view.start + offset}
        class:text-default={focused && selected === view.start + offset}
        role="option"
        aria-selected={selected === view.start + offset}
        data-testid="subagent-row"
        data-state={row.state}
      >
        <span class="min-w-0 flex-1 truncate" title={row.title}>
          {#if row.isMain}main{:else}↳{/if}
          {row.title}
          {#if row.sessionId === activeId}<span class="text-dim">(viewing)</span>{/if}
        </span>
        <span class="shrink-0 {STATE_COLOR[row.state]}">{STATE_LABEL[row.state]}</span>
      </div>
    {/each}
    {#if view.hiddenBelow > 0}
      <div class="px-2 py-0.5 text-dim" data-testid="subagent-more">↓ {view.hiddenBelow} more</div>
    {/if}
    {#if focused}
      <div class="border-t border-line px-2 py-0.5 text-dim">
        ↑↓ move · enter open · x stop or clear · esc back
      </div>
    {/if}
  </div>
{/if}
{#if hintVisible}
  <div class="mt-1 text-2xs text-dim" data-testid="subagent-finished-hint">
    An agent finished. Its conversation stays in the session tabs.
  </div>
{/if}
