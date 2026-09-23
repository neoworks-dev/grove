<script lang="ts">
  import {
    store,
    selectWorktree,
    refreshWorktrees,
    focusAgentInPane
  } from '../../../lib/store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import {
    branchPositionFor,
    checksOutcome,
    diffStatLabel,
    positionTitle,
    pullFor,
    pullTitle
  } from '../../../lib/worktreeStatus'
  import CreateWorktreeDialog from './CreateWorktreeDialog.svelte'
  import MergeWorktreeDialog from './MergeWorktreeDialog.svelte'
  import WorktreeSessionRow from './WorktreeSessionRow.svelte'
  import { onMount } from 'svelte'
  import { agentSessions } from '../../../lib/agents/sessions.svelte'
  import type { Worktree, ServiceRuntime } from '../../../../../shared/types'
  import { sessionAttentionFor, sessionsFor } from '../../../lib/worktreeStatus'
  import { ATTENTION_LABELS } from '../../../lib/agents/attention'
  import BellRingingIcon from 'phosphor-svelte/lib/BellRingingIcon'
  import PaneControls from '../../../components/PaneControls.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import HardDrivesIcon from 'phosphor-svelte/lib/HardDrivesIcon'

  let showDialog = $state(false)
  let mergeSource = $state<Worktree | null>(null)

  // The session rows need the listing polled, and no agent pane may be open to
  // do it; the poll is shared and reference counted, so this adds no second one.
  onMount(() => agentSessions.watch())

  // Select the worktree, focus the Agent pane, and switch it to this session.
  function openSession(worktreeId: string, sessionId: string, event: MouseEvent): void {
    event.stopPropagation()
    agentSessions.acknowledge(sessionId)
    void focusAgentInPane(worktreeId, sessionId)
    layout.ensurePane('agent')
  }

  // Open the worktree's shared chat (arrives beside the agent panel).
  function openChat(worktree: Worktree): void {
    selectWorktree(worktree.id)
    layout.ensurePane('worktree-chat')
  }

  // Reveal the checkpoints timeline in the sidebar for this worktree.
  function openCheckpoints(worktree: Worktree): void {
    selectWorktree(worktree.id)
    layout.ensurePane('checkpoints')
  }

  /** How many of the worktree's workbench.yaml services run, and each one's state for the tooltip. */
  function serviceSummary(worktreeId: string): { running: number; total: number; detail: string } {
    const list: ServiceRuntime[] = store.services[worktreeId] || []
    const running = list.filter((service) => service.status === 'running').length
    const lines = list.map((service) => `${service.name}: ${service.status}`)
    const detail = [`${running} of ${list.length} services running`, ...lines].join('\n')
    return { running, total: list.length, detail }
  }

  /** The tooltip on a worktree's bell: which sessions ended, and how. */
  function attentionTitle(flagged: ReturnType<typeof sessionAttentionFor>): string {
    return flagged
      .map((entry) => `${entry.session.title}: ${ATTENTION_LABELS[entry.attention]}`)
      .join('\n')
  }

  /** The bell's colour: the most pressing of the sessions it stands for. */
  function attentionTone(flagged: ReturnType<typeof sessionAttentionFor>): string {
    if (flagged.some((entry) => entry.attention === 'failed')) return 'text-red'
    if (flagged.some((entry) => entry.attention === 'needs_you')) return 'text-amber'
    return 'text-green'
  }

  function hasActiveAgent(worktreeId: string): boolean {
    return sessionsFor(worktreeId).some((session) => session.status === 'running')
  }

  async function remove(worktree: Worktree, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    const force = worktree.dirty
    let question = `Remove worktree "${worktree.name}"?`
    if (force) question += ' It has uncommitted changes (force).'
    const confirmed = confirm(question)
    if (!confirmed) return
    try {
      await window.workbench.worktrees.remove(worktree.id, force)
      await refreshWorktrees()
      if (store.selectedWorktreeId === worktree.id) {
        const next = store.worktrees[0]?.id
        if (next) await selectWorktree(next)
        else store.selectedWorktreeId = null
      }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-1.5 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Worktrees</span>
    <span class="flex-1"></span>
    <RowAction
      icon={PlusIcon}
      title="New worktree"
      disabled={!store.repo}
      onclick={() => (showDialog = true)}
    />
    <PaneControls />
  </div>

  <div class="flex-1 overflow-y-auto">
    {#each store.worktrees as worktree (worktree.id)}
      {@const summary = serviceSummary(worktree.id)}
      {@const diff = diffStatLabel(worktree.id)}
      {@const sessions = sessionsFor(worktree.id)}
      {@const flagged = sessionAttentionFor(worktree.id)}
      {@const position = branchPositionFor(worktree.id)}
      {@const pull = pullFor(worktree)}
      <div
        class="group/worktree flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
        class:bg-elevated={store.selectedWorktreeId === worktree.id}
        class:hover:bg-hover={store.selectedWorktreeId !== worktree.id}
        role="button"
        tabindex="0"
        onclick={() => selectWorktree(worktree.id)}
        onkeydown={(event) => event.key === 'Enter' && selectWorktree(worktree.id)}
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          class:bg-amber={worktree.dirty}
          class:bg-green={!worktree.dirty}
          title={worktree.dirty ? 'dirty' : 'clean'}
        ></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1">
            <span class="truncate">{worktree.name}</span>
            {#if worktree.isMain}
              <span class="rounded bg-raised px-1 text-2xs text-dim">main</span>
            {/if}
            {#if store.unread[worktree.id]}
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Unread agent output"
              ></span>
            {/if}
          </div>
          <div class="flex items-center gap-1.5 font-mono text-2xs text-dim">
            <span class="truncate">{worktree.branch}</span>
            {#if position}
              <span class="shrink-0" title={positionTitle(position)}>
                {#if position.ahead > 0}↑{position.ahead}{/if}
                {#if position.behind > 0}↓{position.behind}{/if}
              </span>
            {/if}
            {#if pull}
              {@const outcome = checksOutcome(pull)}
              <button
                class="flex shrink-0 cursor-pointer items-center gap-1 hover:text-default"
                class:text-violet={pull.state === 'MERGED'}
                class:line-through={pull.state === 'CLOSED'}
                title={pullTitle(pull)}
                onclick={(event) => {
                  event.stopPropagation()
                  void window.workbench.openExternal(pull.url)
                }}
              >
                #{pull.number}
                {#if outcome}
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    class:bg-green={outcome === 'passed'}
                    class:bg-red={outcome === 'failed'}
                    class:bg-amber={outcome === 'pending'}
                  ></span>
                {/if}
              </button>
            {/if}
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          {#if flagged.length > 0}
            <span
              class="flex items-center gap-0.5 text-2xs {attentionTone(flagged)}"
              title={attentionTitle(flagged)}
            >
              <BellRingingIcon size={12} weight="fill" />
              {#if flagged.length > 1}{flagged.length}{/if}
            </span>
          {/if}
          {#if diff}
            <span class="font-mono text-2xs" title="Lines changed vs HEAD">
              <span class="text-green">+{diff.added}</span>
              <span class="text-red">−{diff.removed}</span>
            </span>
          {/if}
          {#if summary.total > 0}
            <span
              class="flex items-center gap-0.5 text-2xs"
              class:text-green={summary.running > 0}
              class:text-dim={summary.running === 0}
              title={summary.detail}
            >
              <HardDrivesIcon size={11} />
              {summary.running}/{summary.total}
            </span>
          {/if}
          {#if hasActiveAgent(worktree.id)}
            <span class="h-2 w-2 rounded-full bg-violet" title="agent running"></span>
          {/if}
          <button
            class="hidden text-dim hover:text-default group-hover/worktree:block"
            title="Worktree chat"
            onclick={(event) => {
              event.stopPropagation()
              openChat(worktree)
            }}
          >
            ✉
          </button>
          <button
            class="hidden text-dim hover:text-default group-hover/worktree:block"
            title="Checkpoints"
            onclick={(event) => {
              event.stopPropagation()
              openCheckpoints(worktree)
            }}
          >
            ⟲
          </button>
          <button
            class="hidden text-dim hover:text-violet group-hover/worktree:block"
            title="Merge this worktree into another"
            onclick={(event) => {
              event.stopPropagation()
              mergeSource = worktree
            }}
          >
            ⤳
          </button>
          {#if !worktree.isMain}
            <button
              class="hidden text-dim hover:text-red group-hover/worktree:block"
              title="Remove worktree"
              onclick={(event) => remove(worktree, event)}
            >
              ✕
            </button>
          {/if}
        </div>
      </div>

      <!-- One row per agent session in this worktree, running or not. -->
      {#each sessions as session (session.id)}
        <WorktreeSessionRow
          {session}
          attention={agentSessions.attention[session.id]}
          selected={store.selectedWorktreeId === worktree.id}
          onopen={(event) => openSession(worktree.id, session.id, event)}
        />
      {/each}
    {/each}

    {#if store.repo && store.worktrees.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
    {/if}
  </div>
</div>

{#if showDialog}
  <CreateWorktreeDialog onClose={() => (showDialog = false)} />
{/if}

{#if mergeSource}
  <MergeWorktreeDialog
    source={{ id: mergeSource.id, name: mergeSource.name, branch: mergeSource.branch }}
    onClose={() => (mergeSource = null)}
  />
{/if}
