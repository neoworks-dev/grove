<script lang="ts">
  // One conflict in a file the agent proposed resolutions for. It shows the
  // agent's reason (or that it was unsure), and settles the conflict without
  // writing anything: accept the proposal, edit it, or take a side. Settled, it
  // says how, and can be taken back.
  import Button from '@neoworks-dev/ui/Button'
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon'
  import { conflictReview } from '../../../lib/conflictReview.svelte'
  import { decisionLabel, hunkKey, sideLines } from '../../../lib/conflictDecisions'
  import type { ConflictChoice, ConflictHunk, ConflictProposal } from '../../../../../shared/types'

  let {
    worktreeId,
    path,
    index,
    hunk,
    proposal,
    onReveal
  }: {
    worktreeId: string
    path: string
    index: number
    hunk: ConflictHunk
    proposal: ConflictProposal | null
    onReveal: () => void
  } = $props()

  let editing = $state(false)
  let draft = $state('')

  const decision = $derived(conflictReview.decisionsOf(worktreeId)[hunkKey(path, index, hunk)])

  /** "L12", "L12–20". */
  function hunkLabel(): string {
    if (hunk.startLine === hunk.endLine) return `L${hunk.startLine}`
    return `L${hunk.startLine}–${hunk.endLine}`
  }

  function acceptProposal(): void {
    if (!proposal || !proposal.lines) return
    conflictReview.decide(worktreeId, path, index, hunk, { kind: 'proposal', lines: proposal.lines })
  }

  function takeSide(choice: ConflictChoice): void {
    conflictReview.decide(worktreeId, path, index, hunk, {
      kind: choice,
      lines: sideLines(hunk, choice)
    })
  }

  /** Opens the editor on the proposal, or on our side when there is none. */
  function startEditing(): void {
    let lines = hunk.ours
    if (proposal && proposal.lines) lines = proposal.lines
    draft = lines.map((line) => line.replace(/\r$/, '')).join('\n')
    editing = true
  }

  function saveEdit(): void {
    conflictReview.decide(worktreeId, path, index, hunk, {
      kind: 'edited',
      lines: draft.split('\n')
    })
    editing = false
  }

  function undo(): void {
    conflictReview.undecide(worktreeId, path, index, hunk)
  }
</script>

<div class="flex flex-col gap-1 py-1 pr-2 pl-8 text-2xs">
  <div class="flex items-center gap-1">
    <span class="shrink-0 font-mono text-dim" title="{hunk.oursLabel} vs {hunk.theirsLabel}">
      {hunkLabel()}
    </span>
    {#if proposal && !proposal.confident}
      <span class="flex shrink-0 items-center gap-0.5 text-amber" title="The agent was not sure">
        <WarningIcon size={11} /> unsure
      </span>
    {/if}
    {#if decision}
      <span class="min-w-0 flex-1 truncate text-green">✓ {decisionLabel(decision.kind)}</span>
      <button class="shrink-0 text-dim hover:text-default" onclick={undo}>undo</button>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <button class="shrink-0 text-dim hover:text-default" title="Open at the conflict" onclick={onReveal}>
      open
    </button>
  </div>

  {#if proposal}
    <p class="break-words text-muted italic">{proposal.reason}</p>
  {:else}
    <p class="text-dim">No proposal for this one.</p>
  {/if}

  {#if editing}
    <textarea
      class="min-h-20 w-full rounded-sm border border-line bg-input p-1 font-mono text-2xs text-default outline-none focus:border-line-strong"
      spellcheck="false"
      aria-label="Resolution"
      bind:value={draft}
    ></textarea>
    <div class="flex justify-end gap-1">
      <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
      <Button size="sm" variant="primary" onclick={saveEdit}>Use this</Button>
    </div>
  {:else if !decision}
    <div class="flex flex-wrap items-center gap-1">
      {#if proposal && proposal.lines}
        <button
          class="rounded bg-action px-1.5 py-0.5 text-action-fg hover:bg-action-hover"
          title="Use the agent's resolution"
          onclick={acceptProposal}
        >
          accept
        </button>
      {/if}
      <button
        class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default"
        title="Write the resolution yourself, starting from the proposal"
        onclick={startEditing}
      >
        edit
      </button>
      <button
        class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default"
        title="Reject the proposal and keep {hunk.oursLabel || 'our side'}"
        onclick={() => takeSide('ours')}
      >
        ours
      </button>
      <button
        class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default"
        title="Reject the proposal and keep {hunk.theirsLabel || 'their side'}"
        onclick={() => takeSide('theirs')}
      >
        theirs
      </button>
      <button
        class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default"
        title="Reject the proposal and keep both, ours first"
        onclick={() => takeSide('both')}
      >
        both
      </button>
    </div>
  {/if}
</div>
