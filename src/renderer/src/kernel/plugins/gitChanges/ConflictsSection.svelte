<script lang="ts">
  // The unresolved half of a merge, above the ordinary changes. Each file lists
  // its conflicts; taking a side rewrites that one region and leaves the rest of
  // the file's markers alone, so a conflict can equally well be settled by hand
  // in the editor — `open` puts the cursor on it.
  //
  // A file with nothing left to resolve is staged, which is what moves it out of
  // here and into the changes list.
  //
  // "Resolve with agent" asks an agent for a proposal per conflict. A file it
  // proposed anything for is reviewed rather than written conflict by conflict:
  // each one is settled (accepted, edited, or a side taken) and nothing is
  // written or staged until every conflict under review is.
  import Button from '@neoworks-dev/ui/Button'
  import SparkleIcon from 'phosphor-svelte/lib/SparkleIcon'
  import GitDiffIcon from 'phosphor-svelte/lib/GitDiffIcon'
  import GitSection from './GitSection.svelte'
  import ConflictProposalRow from './ConflictProposalRow.svelte'
  import RowAction from './RowAction.svelte'
  import { store, openFileAtLine } from '../../../lib/store.svelte'
  import { conflictReview } from '../../../lib/conflictReview.svelte'
  import {
    previewResolutions,
    proposalFor,
    reviewedFiles,
    settledCount
  } from '../../../lib/conflictDecisions'
  import { openTextDiff } from '../../../lib/nvim/revisionDiff'
  import type { ConflictChoice, ConflictedFile, ConflictHunk } from '../../../../../shared/types'

  let {
    worktreeId,
    files,
    onResolved
  }: { worktreeId: string; files: ConflictedFile[]; onResolved: () => void } = $props()

  let expandedPath = $state<string | null>(null)
  let busy = $state(false)

  // The first file opens on its own: a merge that conflicts in one file is the
  // common case, and it would otherwise take a click to see anything at all.
  const openPath = $derived.by(() => {
    if (expandedPath) return expandedPath
    if (files.length > 0) return files[0].path
    return null
  })

  const proposals = $derived(conflictReview.proposalsOf(worktreeId))
  const reviewed = $derived(reviewedFiles(files, proposals))
  const progress = $derived(settledCount(files, proposals, conflictReview.decisionsOf(worktreeId)))
  const starting = $derived(conflictReview.starting[worktreeId] === true)

  // Proposals arrive while the agent works; read what is there and follow it.
  $effect(() => {
    void conflictReview.load(worktreeId)
  })
  $effect(() => conflictReview.watch())

  /** Whether a file's conflicts are being reviewed rather than written one at a time. */
  function isReviewed(file: ConflictedFile): boolean {
    return reviewed.some((entry) => entry.path === file.path)
  }

  /** Asks an agent for proposals: for one file, or every conflicted file. */
  function resolveWithAgent(file: ConflictedFile | null): void {
    const worktree = store.selectedWorktree
    if (!worktree) return
    let paths: string[] | null = null
    if (file) paths = [file.path]
    void conflictReview.startAgent(worktreeId, worktree.path, paths)
  }

  /** Opens a file as it is beside the file grove would write from the review so far. */
  async function previewFile(file: ConflictedFile): Promise<void> {
    const resolutions = previewResolutions(
      file,
      proposals,
      conflictReview.decisionsOf(worktreeId)
    )
    try {
      // Decisions and proposals are $state proxies, which cannot cross IPC.
      const sides = await window.workbench.conflicts.preview(
        worktreeId,
        file.path,
        $state.snapshot(resolutions)
      )
      await openTextDiff({
        path: file.path,
        left: sides.current,
        right: sides.resolved,
        leftLabel: 'conflicted',
        rightLabel: 'proposed'
      })
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Writes every settled conflict back and stages what is clean. */
  async function writeReviewed(): Promise<void> {
    busy = true
    try {
      await conflictReview.writeAll(worktreeId, files)
      onResolved()
    } finally {
      busy = false
    }
  }

  function absPathFor(file: ConflictedFile): string | null {
    const root = store.selectedWorktree?.path
    if (!root) return null
    return `${root}/${file.path}`
  }

  function toggle(file: ConflictedFile): void {
    if (openPath === file.path) expandedPath = null
    else expandedPath = file.path
  }

  function reveal(file: ConflictedFile, hunk: ConflictHunk): void {
    const absPath = absPathFor(file)
    if (!absPath) return
    openFileAtLine(worktreeId, absPath, hunk.startLine)
  }

  async function resolve(
    file: ConflictedFile,
    hunkIndex: number,
    choice: ConflictChoice
  ): Promise<void> {
    busy = true
    try {
      const remaining = await window.workbench.git.resolveConflict(
        worktreeId,
        file.path,
        hunkIndex,
        choice
      )
      if (remaining.length === 0) {
        await window.workbench.git.stage(worktreeId, [file.path])
      }
      onResolved()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  function hunkLabel(hunk: ConflictHunk): string {
    if (hunk.startLine === hunk.endLine) return `L${hunk.startLine}`
    return `L${hunk.startLine}–${hunk.endLine}`
  }
</script>

<GitSection title="Merge Conflicts" count={files.length} danger>
  <div class="flex items-center gap-2 py-1 pr-2 pl-5 text-2xs">
    {#if reviewed.length > 0}
      <span class="min-w-0 flex-1 truncate text-dim">
        {progress.settled} of {progress.total} settled
      </span>
      <Button size="sm" variant="ghost" onclick={() => conflictReview.discard(worktreeId)}>
        Discard
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={busy || progress.total === 0 || progress.settled < progress.total}
        onclick={writeReviewed}
      >
        Write & stage
      </Button>
    {:else}
      <span class="flex-1"></span>
      <Button size="sm" icon={SparkleIcon} disabled={starting} onclick={() => resolveWithAgent(null)}>
        Resolve with agent
      </Button>
    {/if}
  </div>
  {#each files as file (file.path)}
    <div class="flex w-full items-center gap-1 pr-2 text-xs text-muted hover:bg-hover">
      <button
        class="flex min-w-0 flex-1 items-center gap-1 py-[3px] pl-1 text-left"
        onclick={() => toggle(file)}
      >
        <span class="w-3 shrink-0 text-center text-2xs text-dim"
          >{openPath === file.path ? '▾' : '▸'}</span
        >
        <span class="w-3 shrink-0 text-center font-mono text-2xs text-red">!</span>
        <span class="truncate">{file.path}</span>
      </button>
      {#if isReviewed(file)}
        <RowAction
          icon={GitDiffIcon}
          title="Show the file as the review would write it"
          onclick={() => previewFile(file)}
        />
      {:else if file.hunks.length > 0}
        <RowAction
          icon={SparkleIcon}
          title="Resolve this file with an agent"
          disabled={starting}
          onclick={() => resolveWithAgent(file)}
        />
      {/if}
      <span class="shrink-0 text-2xs text-dim">
        {#if file.hunks.length === 0}
          no markers
        {:else}
          {file.hunks.length} hunk{file.hunks.length === 1 ? '' : 's'}
        {/if}
      </span>
    </div>

    {#if openPath === file.path && isReviewed(file)}
      {#each file.hunks as hunk, index (hunk.startLine)}
        <ConflictProposalRow
          {worktreeId}
          path={file.path}
          {index}
          {hunk}
          proposal={proposalFor(proposals, file.path, index)}
          onReveal={() => reveal(file, hunk)}
        />
      {/each}
    {:else if openPath === file.path}
      {#each file.hunks as hunk, index (hunk.startLine)}
        <div class="flex items-center gap-1 py-1 pl-8 pr-2 text-2xs">
          <span class="shrink-0 font-mono text-dim" title="{hunk.oursLabel} vs {hunk.theirsLabel}">
            {hunkLabel(hunk)}
          </span>
          <div class="ml-auto flex shrink-0 items-center gap-1">
            <button
              class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-40"
              title="Keep {hunk.oursLabel || 'our side'}"
              disabled={busy}
              onclick={() => resolve(file, index, 'ours')}
            >
              ours
            </button>
            <button
              class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-40"
              title="Keep {hunk.theirsLabel || 'their side'}"
              disabled={busy}
              onclick={() => resolve(file, index, 'theirs')}
            >
              theirs
            </button>
            <button
              class="rounded border border-line px-1.5 py-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-40"
              title="Keep both, ours first"
              disabled={busy}
              onclick={() => resolve(file, index, 'both')}
            >
              both
            </button>
            <button
              class="rounded px-1.5 py-0.5 text-dim hover:text-default"
              title="Open at the conflict"
              onclick={() => reveal(file, hunk)}
            >
              open
            </button>
          </div>
        </div>
      {/each}

      {#if file.hunks.length === 0}
        <p class="py-1 pl-8 pr-3 text-2xs text-dim">
          Conflicted over the file itself, not its contents — resolve it by staging the version you
          want, or removing it.
        </p>
      {/if}
    {/if}
  {/each}
</GitSection>
