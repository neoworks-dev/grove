<script lang="ts">
  // The unresolved half of a merge, above the ordinary changes. Each file lists
  // its conflicts; taking a side rewrites that one region and leaves the rest of
  // the file's markers alone, so a conflict can equally well be settled by hand
  // in the editor — `open` puts the cursor on it.
  //
  // A file with nothing left to resolve is staged, which is what moves it out of
  // here and into the changes list.
  import { store, openFileAtLine } from '../../../lib/store.svelte'
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

<div class="border-b border-line">
  <div class="flex items-center gap-1.5 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-red">
      ⚠ Conflicts ({files.length})
    </span>
  </div>

  {#each files as file (file.path)}
    <button
      class="flex w-full items-center gap-2 py-1.5 pl-3 pr-2 text-left text-xs hover:bg-hover"
      onclick={() => toggle(file)}
    >
      <span class="w-4 shrink-0 font-mono text-red">!</span>
      <span class="truncate">{file.path}</span>
      <span class="ml-auto shrink-0 text-2xs text-dim">
        {#if file.hunks.length === 0}
          no markers
        {:else}
          {file.hunks.length} hunk{file.hunks.length === 1 ? '' : 's'}
        {/if}
      </span>
    </button>

    {#if openPath === file.path}
      {#each file.hunks as hunk, index (hunk.startLine)}
        <div class="flex items-center gap-1 py-1 pl-9 pr-2 text-2xs">
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
        <p class="py-1 pl-9 pr-3 text-2xs text-dim">
          Conflicted over the file itself, not its contents — resolve it by staging the version you
          want, or removing it.
        </p>
      {/if}
    {/if}
  {/each}
</div>
