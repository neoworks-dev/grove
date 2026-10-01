<script lang="ts">
  // A session, replayed: its turns in order, each with the edits it made, and a
  // scrubber that steps through them. Each step is a tool call that changed the
  // worktree, recorded with the state before and after it. From a step: open
  // what it changed, compare its state with the working tree or with another
  // step, or roll the worktree back to it.
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import GitDiffIcon from 'phosphor-svelte/lib/GitDiffIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import PaneControls from '../../../components/PaneControls.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import ReplayFileRow from './ReplayFileRow.svelte'
  import { agentSessions } from '../../../lib/agents/sessions.svelte'
  import { store, refreshDiffStats } from '../../../lib/store.svelte'
  import { dialogs } from '../../../lib/dialogs.svelte'
  import { openRevisionDiff, openWorkingTreeDiff } from '../../../lib/nvim/revisionDiff'
  import {
    filesLabel,
    lineTotals,
    positionsOf,
    promptHeadline,
    stepTitle,
    type ReplayPosition
  } from '../../../lib/agents/replay'
  import { replayTarget } from './target.svelte'
  import type { AgentEditStep, SessionReplay } from '../../../../../shared/agents'
  import type { TreeFileChange } from '../../../../../shared/types'

  let replay = $state<SessionReplay | null>(null)
  let selected = $state(0)
  let compareFrom = $state<number | null>(null)
  let comparison = $state<TreeFileChange[] | null>(null)
  let busy = $state(false)
  let loadError = $state<string | null>(null)
  let timeline = $state<HTMLDivElement>()

  const worktreePath = $derived.by(() => {
    const worktree = store.selectedWorktree
    if (!worktree) return ''
    return worktree.path
  })
  const sessions = $derived(agentSessions.forWorktree(worktreePath))
  const sessionId = $derived.by(() => {
    if (replayTarget.sessionId) return replayTarget.sessionId
    if (!worktreePath) return null
    return agentSessions.resolveActive(worktreePath)
  })
  const positions = $derived.by(() => {
    if (!replay) return []
    return positionsOf(replay)
  })
  const current = $derived(positionAt(selected))
  const comparePosition = $derived.by(() => {
    if (compareFrom === null) return null
    return positionAt(compareFrom)
  })

  /** The stop at an index on the scrubber, or null past either end. */
  function positionAt(index: number): ReplayPosition | null {
    const position = positions[index]
    if (!position) return null
    return position
  }

  /** Reads the session's turns and steps; keeps the scrubber where it was when it can. */
  async function load(id: string): Promise<void> {
    try {
      const next = await window.workbench.replay.session(id)
      if (id !== sessionId) return
      replay = next
      loadError = null
      const count = positionsOf(next).length
      if (replayTarget.stepIndex !== null) {
        selected = Math.min(replayTarget.stepIndex, Math.max(0, count - 1))
        replayTarget.stepIndex = null
        return
      }
      if (selected >= count) selected = Math.max(0, count - 1)
    } catch (err) {
      replay = null
      loadError = (err as Error).message
    }
  }

  // Follow the session, and reload whenever it records another step.
  $effect(() => {
    const id = sessionId
    replay = null
    selected = 0
    compareFrom = null
    if (!id) return
    void load(id)
    return window.workbench.on('event:agent-step', (payload) => {
      const event = payload as { sessionId: string }
      if (event.sessionId === id) void load(id)
    })
  })

  // The session list only updates while something is watching it.
  $effect(() => agentSessions.watch())

  // A comparison is between the pinned stop and the selected one.
  $effect(() => {
    const from = comparePosition
    const to = current
    comparison = null
    if (!from || !to || !replay || from.index === to.index) return
    void compare(replay.sessionId, from.tree, to.tree)
  })

  // Keep the selected stop in view as the scrubber moves.
  $effect(() => {
    const index = selected
    const row = timeline?.querySelector(`[data-position="${index}"]`)
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' })
  })

  /** Files between two recorded states. */
  async function compare(id: string, from: string, to: string): Promise<void> {
    try {
      comparison = await window.workbench.replay.compare(id, from, to)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Another session picked from the header. */
  function pickSession(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value
    replayTarget.sessionId = value
    replayTarget.stepIndex = null
  }

  /** Moves the scrubber by `delta` stops. */
  function step(delta: number): void {
    const next = selected + delta
    if (next < 0 || next >= positions.length) return
    selected = next
  }

  /** j/k and the arrow keys walk the timeline while the pane has focus. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return
    }
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
      return
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    }
  }

  /** How a stop reads where it is named: "the start", "step 3". */
  function positionName(position: ReplayPosition): string {
    if (position.index === 0) return 'start'
    return `step ${position.index}`
  }

  /** Opens what one step did to a file: before the call beside after it. */
  function openStepFile(change: AgentEditStep, file: TreeFileChange): void {
    if (!replay) return
    void openRevisionDiff({
      worktreeId: replay.workspaceRoot,
      path: file.path,
      leftRevision: change.before,
      rightRevision: change.after,
      leftLabel: `before step ${change.index}`,
      rightLabel: `step ${change.index}`
    })
  }

  /** Opens a file as a stop left it, beside the working tree. */
  function openAgainstNow(position: ReplayPosition, file: TreeFileChange): void {
    if (!replay) return
    void openWorkingTreeDiff({
      worktreeId: replay.workspaceRoot,
      worktreePath: replay.workspaceRoot,
      path: file.path,
      revision: position.tree,
      label: positionName(position),
      deleted: false
    })
  }

  /** Opens a file as it differs between the two compared stops. */
  function openComparedFile(file: TreeFileChange): void {
    if (!replay || !comparePosition || !current) return
    void openRevisionDiff({
      worktreeId: replay.workspaceRoot,
      path: file.path,
      leftRevision: comparePosition.tree,
      rightRevision: current.tree,
      leftLabel: positionName(comparePosition),
      rightLabel: positionName(current)
    })
  }

  /** Puts the worktree back as a stop left it, after asking. */
  async function rollBack(position: ReplayPosition): Promise<void> {
    if (!replay) return
    const picked = await dialogs.confirm({
      title: `Roll the worktree back to ${positionName(position)}?`,
      body: 'Uncommitted changes are checkpointed first, so this can be undone from Checkpoints.',
      actions: [
        { id: 'roll-back', label: 'Roll back', kind: 'danger' },
        { id: 'cancel', label: 'Cancel' }
      ]
    })
    if (picked !== 'roll-back') return
    busy = true
    try {
      await window.workbench.replay.restore(replay.sessionId, position.tree)
      void refreshDiffStats(replay.workspaceRoot)
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Pins a stop as the left side of a comparison, or unpins it. */
  function toggleCompare(position: ReplayPosition): void {
    if (compareFrom === position.index) {
      compareFrom = null
      return
    }
    compareFrom = position.index
  }
</script>

{#snippet stopActions(position: ReplayPosition)}
  <div class="flex flex-wrap items-center gap-1 py-1 pr-2 pl-6">
    <button
      class="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-muted hover:bg-hover hover:text-default"
      class:text-violet={compareFrom === position.index}
      title="Compare this state with another step"
      onclick={() => toggleCompare(position)}
    >
      <GitDiffIcon size={12} />
      {#if compareFrom === position.index}Comparing from here{:else}Compare from here{/if}
    </button>
    <button
      class="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-muted hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={busy}
      title="Restore the worktree to this state"
      onclick={() => rollBack(position)}
    >
      <ArrowCounterClockwiseIcon size={12} />
      Roll back to here
    </button>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="flex h-full min-h-0 flex-col text-xs outline-none"
  tabindex="0"
  role="region"
  aria-label="Session replay"
  onkeydown={onKeydown}
>
  <div class="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
    <span class="text-2xs font-semibold tracking-caps text-dim uppercase">Replay</span>
    {#if sessions.length > 0}
      <select
        class="min-w-0 flex-1 truncate rounded-sm border border-line bg-input px-1 py-0.5 text-2xs text-default outline-none"
        aria-label="Session"
        value={sessionId}
        onchange={pickSession}
      >
        {#each sessions as session (session.id)}
          <option value={session.id}>{session.title}</option>
        {/each}
        {#if sessionId && !sessions.some((session) => session.id === sessionId) && replay}
          <option value={sessionId}>{replay.title}</option>
        {/if}
      </select>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <PaneControls />
  </div>

  {#if positions.length > 0}
    <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
      <RowAction
        icon={CaretLeftIcon}
        title="Previous step (k)"
        disabled={selected === 0}
        onclick={() => step(-1)}
      />
      <input
        class="min-w-0 flex-1 accent-accent"
        type="range"
        min="0"
        max={positions.length - 1}
        aria-label="Step"
        bind:value={selected}
      />
      <RowAction
        icon={CaretRightIcon}
        title="Next step (j)"
        disabled={selected === positions.length - 1}
        onclick={() => step(1)}
      />
      <span class="w-16 shrink-0 text-right font-mono text-2xs text-dim">
        {selected} / {positions.length - 1}
      </span>
    </div>
  {/if}

  {#if comparePosition && current && comparePosition.index !== current.index}
    <div class="shrink-0 border-b border-line py-1">
      <div class="flex items-center gap-1 px-2">
        <span class="min-w-0 flex-1 truncate text-2xs text-violet">
          {positionName(comparePosition)} → {positionName(current)}
        </span>
        <RowAction icon={XIcon} title="Stop comparing" onclick={() => (compareFrom = null)} />
      </div>
      {#if comparison === null}
        <p class="px-2 text-2xs text-dim">Comparing…</p>
      {:else if comparison.length === 0}
        <p class="px-2 text-2xs text-dim">The two states are the same.</p>
      {:else}
        <div role="tree" class="max-h-40 overflow-auto">
          {#each comparison as file (file.path)}
            <ReplayFileRow
              {file}
              onOpen={openComparedFile}
              onCompareWithNow={(changed) => openAgainstNow(current, changed)}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <FloatingScrollbar class="min-h-0 flex-1">
    <div bind:this={timeline} class="flex flex-col pb-2">
      {#if loadError}
        <p class="px-3 py-4 text-red">{loadError}</p>
      {:else if !sessionId}
        <p class="px-3 py-4 text-dim">No agent session in this worktree to replay.</p>
      {:else if !replay}
        <p class="px-3 py-4 text-dim">Loading…</p>
      {:else if positions.length === 0}
        <p class="px-3 py-4 text-dim">
          This session has not changed any files yet. Each edit it makes becomes a step here.
        </p>
      {:else}
        <button
          class="flex items-center gap-2 px-2 py-1 text-left hover:bg-hover"
          class:bg-raised={selected === 0}
          data-position={0}
          onclick={() => (selected = 0)}
        >
          <span class="w-5 shrink-0 text-right font-mono text-2xs text-dim">0</span>
          <span class="min-w-0 flex-1 truncate text-muted">Before the first edit</span>
        </button>
        {#if selected === 0 && positions[0]}
          {@render stopActions(positions[0])}
        {/if}

        {#each replay.turns as turn (turn.seq ?? 'start')}
          {#if turn.steps.length > 0 || turn.seq !== null}
            <div class="mt-1 flex items-baseline gap-2 border-t border-line px-2 pt-1.5 pb-1">
              {#if turn.from}
                <span class="shrink-0 text-2xs font-semibold text-dim">{turn.from}</span>
              {/if}
              <span class="min-w-0 flex-1 truncate text-default" title={turn.prompt}>
                {promptHeadline(turn.prompt) || 'Edits before the first message'}
              </span>
            </div>
          {/if}
          {#each turn.steps as change (change.index)}
            {@const totals = lineTotals(change.files)}
            <button
              class="flex items-center gap-2 px-2 py-1 text-left hover:bg-hover"
              class:bg-raised={selected === change.index}
              data-position={change.index}
              onclick={() => (selected = change.index)}
            >
              <span class="w-5 shrink-0 text-right font-mono text-2xs text-dim">{change.index}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-muted" title={stepTitle(change)}>
                {stepTitle(change)}
              </span>
              <span class="shrink-0 text-2xs text-dim">{filesLabel(change.files.length)}</span>
              <span class="shrink-0 font-mono text-2xs text-green">+{totals.added}</span>
              <span class="shrink-0 font-mono text-2xs text-red">−{totals.removed}</span>
            </button>
            {#if selected === change.index && current}
              <div role="tree">
                {#each change.files as file (file.path)}
                  <ReplayFileRow
                    {file}
                    onOpen={(opened) => openStepFile(change, opened)}
                    onCompareWithNow={(opened) => openAgainstNow(current, opened)}
                  />
                {/each}
              </div>
              {@render stopActions(current)}
            {/if}
          {/each}
        {/each}
      {/if}
    </div>
  </FloatingScrollbar>
</div>
