<script lang="ts">
  // Cross-worktree agent cockpit. Groups every worktree's agent sessions so the
  // running ones are easy to spot: each row shows a live status dot, a working
  // spinner, an attention badge (unread / waiting), and the agent's last words.
  // Clicking a worktree header selects it and focuses the Agent pane; clicking a
  // session also switches the pane to it.
  import { onMount } from 'svelte'
  import { store, selectWorktree, focusAgentInPane } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { nibSessions } from '../lib/nib/sessions.svelte'
  import {
    attentionFor,
    lastAgentLineFor,
    sessionsFor,
    sessionStatusColor,
    diffStatLabel
  } from '../lib/worktreeStatus'
  import WaveSpinner from './WaveSpinner.svelte'
  import type { SessionMeta } from '../lib/nib/types'

  // The session listing is polled centrally; this keeps it live while the
  // overview is on screen even when no agent pane is open.
  onMount(() => nibSessions.watch())

  function titleOf(session: SessionMeta): string {
    if (session.title.trim().length > 0) return session.title
    return session.model || 'Session'
  }

  // Select the worktree and open/focus the full Agent pane.
  function focusWorktree(worktreeId: string): void {
    selectWorktree(worktreeId)
    layout.ensurePane('agent')
  }

  // Select the worktree, focus the pane, and switch it to this session.
  function openSession(worktreeId: string, sessionId: string): void {
    void focusAgentInPane(worktreeId, sessionId)
    layout.ensurePane('agent')
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Agents</span>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#each store.worktrees as worktree (worktree.id)}
      {@const sessions = sessionsFor(worktree.id)}
      {@const attention = attentionFor(worktree.id)}
      {@const diff = diffStatLabel(worktree.id)}
      <div class="border-b border-line">
        <!-- Worktree header -->
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover {store.selectedWorktreeId ===
          worktree.id
            ? 'bg-surface'
            : ''}"
          onclick={() => focusWorktree(worktree.id)}
        >
          <span class="truncate text-xs font-semibold">{worktree.name}</span>
          <span class="truncate font-mono text-2xs text-dim">{worktree.branch}</span>
          {#if diff}
            <span class="ml-auto shrink-0 font-mono text-2xs" title="Lines changed vs HEAD">
              <span class="text-green">+{diff.added}</span>
              <span class="text-red">−{diff.removed}</span>
            </span>
          {/if}
        </button>

        <!-- Agent rows -->
        {#if sessions.length === 0}
          <div class="px-3 pb-1.5 pl-5 text-2xs text-dim">idle — no sessions</div>
        {:else}
          {#each sessions as session (session.id)}
            {@const working = session.status === 'running'}
            {@const perm = session.pendingApprovals.length > 0}
            {@const line = lastAgentLineFor(session.id)}
            <button
              class="flex w-full flex-col gap-0.5 py-1 pl-5 pr-3 text-left hover:bg-hover"
              onclick={() => openSession(worktree.id, session.id)}
            >
              <div class="flex items-center gap-2">
                <span class="h-2 w-2 shrink-0 rounded-full {sessionStatusColor(session)}"></span>
                <span class="truncate text-xs font-medium text-default">{titleOf(session)}</span>
                <span class="truncate text-2xs text-muted">{session.model}</span>
                {#if working}
                  <span class="text-green"><WaveSpinner count={3} /></span>
                {/if}
                {#if perm}
                  <span class="ml-auto shrink-0 text-2xs text-amber" title="Waiting on permission"
                    >⊘ perm</span
                  >
                {:else if attention.unread}
                  <span class="ml-auto shrink-0 text-2xs text-amber" title="Unread agent output"
                    >✉ unread</span
                  >
                {:else if session.stopReason === 'error'}
                  <span class="ml-auto shrink-0 text-2xs text-red" title="Ended with an error"
                    >✕ error</span
                  >
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
</div>
