<script lang="ts">
  // The fleet view inside the agent pane.
  //
  // Reached with ArrowLeft from an empty composer, so stepping back out of one
  // conversation shows every other one: every worktree's sessions, whichever
  // harness they run on, with the signals that decide which to attend to next —
  // running, waiting on permission, unread, errored.
  //
  // Choosing a session is a jump: it selects that worktree and makes the session
  // the pane's active one. The sidebar's AgentsOverview shows the same fleet, but
  // it navigates the whole workbench; this one only moves the pane it lives in.

  import Icon from '@iconify/svelte'
  import { onMount } from 'svelte'
  import { store } from '../../../../lib/store.svelte'
  import { catalog } from '../../../../lib/agents/catalog.svelte'
  import { agentSessions } from '../../../../lib/agents/sessions.svelte'
  import {
    diffStatLabel,
    lastAgentLineFor,
    sessionsFor,
    sessionStatusColor
  } from '../../../../lib/worktreeStatus'
  import WaveSpinner from '../../../../components/WaveSpinner.svelte'
  import Kbd from '../../../../components/Kbd.svelte'
  import type { SessionMeta } from '../../../../lib/agents/types'

  let {
    activeSessionId,
    onOpen,
    onClose
  }: {
    activeSessionId: string | null
    onOpen: (worktreeId: string, sessionId: string) => void
    onClose: () => void
  } = $props()

  interface WorktreeGroup {
    id: string
    name: string
    branch: string
    sessions: SessionMeta[]
  }

  const groups = $derived<WorktreeGroup[]>(
    store.worktrees.map((worktree) => ({
      id: worktree.id,
      name: worktree.name,
      branch: worktree.branch,
      sessions: sessionsFor(worktree.id)
    }))
  )

  // The selectable rows, flattened: only sessions are landable, worktree headers
  // are dividers.
  const rows = $derived(
    groups.flatMap((group) => group.sessions.map((session) => ({ worktreeId: group.id, session })))
  )

  let selected = $state(0)
  let container = $state<HTMLDivElement>()

  // Open on the session the pane was showing, so ArrowLeft then ArrowRight is a
  // round trip rather than a jump to the top of the fleet.
  onMount(() => {
    const current = rows.findIndex((row) => row.session.id === activeSessionId)
    if (current >= 0) selected = current
    container?.focus()
  })

  // Sessions come and go while the overview is up; a selection past the end
  // would leave Enter doing nothing.
  $effect(() => {
    if (selected < rows.length) return
    selected = Math.max(rows.length - 1, 0)
  })

  function move(step: number): void {
    if (rows.length === 0) return
    selected = (selected + step + rows.length) % rows.length
  }

  function openSelected(): void {
    const row = rows[selected]
    if (!row) return
    onOpen(row.worktreeId, row.session.id)
  }

  function indexOfSession(sessionId: string): number {
    return rows.findIndex((row) => row.session.id === sessionId)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter' || event.key === 'ArrowRight' || event.key === 'l') {
      event.preventDefault()
      openSelected()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  function titleOf(session: SessionMeta): string {
    if (session.title.trim().length > 0) return session.title
    if (session.model.length > 0) return session.model
    return 'Session'
  }

  /** The harness's mark, or none when the runtime that ran it is not mounted. */
  function iconOf(session: SessionMeta): string | null {
    const harness = catalog.harnesses.find((entry) => entry.id === session.harness)
    if (!harness) return null
    return harness.icon
  }

  function unreadFor(sessionId: string): boolean {
    const live = agentSessions.live[sessionId]
    if (!live) return false
    return live.unread > 0
  }
</script>

<!-- Keyboard-driven, so the list itself takes focus rather than any one row. -->
<div
  bind:this={container}
  class="min-h-0 flex-1 overflow-auto outline-none"
  role="listbox"
  aria-label="Agent sessions"
  tabindex="-1"
  onkeydown={onKey}
>
  <div class="flex items-center gap-2 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">All sessions</span>
    <span class="ml-auto flex items-center gap-1 text-2xs text-dim">
      <Kbd>↵</Kbd> open · <Kbd>esc</Kbd> back
    </span>
  </div>

  {#each groups as group (group.id)}
    {@const diff = diffStatLabel(group.id)}
    <div class="border-b border-line">
      <div class="flex items-center gap-2 px-3 py-1.5">
        <span class="truncate text-xs font-semibold">{group.name}</span>
        <span class="truncate font-mono text-2xs text-dim">{group.branch}</span>
        {#if diff}
          <span class="ml-auto shrink-0 font-mono text-2xs" title="Lines changed vs HEAD">
            <span class="text-green">+{diff.added}</span>
            <span class="text-red">−{diff.removed}</span>
          </span>
        {/if}
      </div>

      {#if group.sessions.length === 0}
        <div class="px-3 pb-1.5 pl-5 text-2xs text-dim">idle — no sessions</div>
      {:else}
        {#each group.sessions as session (session.id)}
          {@const index = indexOfSession(session.id)}
          {@const icon = iconOf(session)}
          {@const line = lastAgentLineFor(session.id)}
          <button
            class="flex w-full flex-col gap-0.5 py-1 pl-5 pr-3 text-left hover:bg-hover"
            class:bg-elevated={index === selected}
            role="option"
            aria-selected={index === selected}
            onclick={() => onOpen(group.id, session.id)}
            onmouseenter={() => (selected = index)}
          >
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 shrink-0 rounded-full {sessionStatusColor(session)}"></span>
              {#if icon}
                <Icon {icon} class="size-3.5 shrink-0 text-dim" />
              {/if}
              <span class="truncate text-xs font-medium text-default">{titleOf(session)}</span>
              <span class="truncate text-2xs text-muted">{session.model}</span>
              {#if session.status === 'running'}
                <span class="text-green"><WaveSpinner count={3} /></span>
              {/if}
              {#if session.pendingApprovals.length > 0}
                <span class="ml-auto shrink-0 text-2xs text-amber" title="Waiting on permission">
                  ⊘ perm
                </span>
              {:else if unreadFor(session.id)}
                <span class="ml-auto shrink-0 text-2xs text-amber" title="Unread agent output">
                  ✉ unread
                </span>
              {:else if session.stopReason === 'error'}
                <span class="ml-auto shrink-0 text-2xs text-red" title="Ended with an error">
                  ✕ error
                </span>
              {/if}
            </div>
            {#if line}
              <div class="truncate pl-4 text-2xs text-dim">{line}</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/each}

  {#if store.worktrees.length === 0}
    <p class="px-3 py-4 text-xs text-dim">No worktrees.</p>
  {/if}
</div>
