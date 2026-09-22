<script lang="ts">
  // One changed file. Clicking it opens the file with its hunks painted by the
  // review overlay; the caret lists those hunks right here, each one stageable
  // on its own. The hunks are loaded when the row opens and again whenever the
  // view reloads, since staging one renumbers the rest.
  import Icon from '@iconify/svelte'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import FileIcon from 'phosphor-svelte/lib/FileIcon'
  import RowAction from './RowAction.svelte'
  import { store, openFileAtLine, openFileInEditor } from '../../../lib/store.svelte'
  import { fileIcon } from '../../../lib/icons'
  import { baseName, directoryName } from './changeTree'
  import type { DiffFile, DiffHunk } from '../../../../../shared/types'

  let {
    worktreeId,
    file,
    depth,
    showDirectory,
    selected,
    refreshKey,
    onReview,
    onChanged
  }: {
    worktreeId: string
    file: DiffFile
    depth: number
    showDirectory: boolean
    selected: boolean
    refreshKey: number
    onReview: (file: DiffFile) => void
    onChanged: () => void
  } = $props()

  let expanded = $state(false)
  let hunks = $state<DiffHunk[]>([])
  let busy = $state(false)

  const statusColour: Record<string, string> = {
    added: 'text-green',
    modified: 'text-amber',
    deleted: 'text-red',
    renamed: 'text-blue',
    untracked: 'text-violet'
  }

  // Only a plain content change splits into hunks git can apply one at a time;
  // a whole-file add, delete or rename is staged as the file.
  const splittable = $derived(
    file.changeType === 'modified' || (file.changeType === 'added' && file.staged)
  )
  const indent = $derived(depth * 12 + 4)

  /** The file's icon in the active pack; reads the pack so a switch repaints it. */
  function iconFor(changed: DiffFile): string {
    void store.iconPack
    return fileIcon(baseName(changed.path))
  }

  /** Absolute path of the file in the selected worktree. */
  function absolutePath(): string | null {
    const root = store.selectedWorktree?.path
    if (!root) return null
    return `${root}/${file.path}`
  }

  /** Fetches the file's hunks, or clears them if the file has none to split. */
  async function loadHunks(): Promise<void> {
    if (!splittable) {
      hunks = []
      return
    }
    try {
      const result = await window.workbench.git.diffHunks(worktreeId, $state.snapshot(file))
      hunks = result.hunks
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  $effect(() => {
    void refreshKey
    if (expanded) void loadHunks()
  })

  /** Stages or unstages the whole file. */
  async function toggleFile(): Promise<void> {
    const path = file.path
    await run(async () => {
      if (file.staged) await window.workbench.git.unstage(worktreeId, [path])
      else await window.workbench.git.stage(worktreeId, [path])
    })
  }

  /** Stages or unstages one hunk of the file. */
  async function toggleHunk(hunkIndex: number): Promise<void> {
    const snapshot = $state.snapshot(file)
    await run(async () => {
      if (snapshot.staged) await window.workbench.git.unstageHunk(worktreeId, snapshot, hunkIndex)
      else await window.workbench.git.stageHunk(worktreeId, snapshot, hunkIndex)
    })
  }

  /** Runs a git change with the row marked busy, then has the view reload. */
  async function run(change: () => Promise<void>): Promise<void> {
    busy = true
    try {
      await change()
      onChanged()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Opens the file itself, without the review overlay. */
  function openFile(): void {
    const path = absolutePath()
    if (path) openFileInEditor(worktreeId, path)
  }

  /** Opens the file with the cursor on a hunk. */
  function revealHunk(hunk: DiffHunk): void {
    const path = absolutePath()
    if (path) openFileAtLine(worktreeId, path, Math.max(1, hunk.modifiedStart))
  }

  /** The lines a hunk covers in the new version, as `L12` or `L12–18`. */
  function hunkLabel(hunk: DiffHunk): string {
    if (hunk.modifiedCount <= 1) return `L${Math.max(1, hunk.modifiedStart)}`
    return `L${hunk.modifiedStart}–${hunk.modifiedStart + hunk.modifiedCount - 1}`
  }
</script>

<div
  class="group flex w-full cursor-pointer items-center gap-1 py-[3px] pr-2 text-xs select-none hover:bg-hover"
  class:bg-hover={selected}
  class:text-default={selected}
  class:text-muted={!selected}
  style:padding-left="{indent}px"
  role="treeitem"
  tabindex="-1"
  aria-selected={selected}
  aria-expanded={splittable ? expanded : undefined}
  onclick={() => onReview(file)}
  onkeydown={(event) => event.key === 'Enter' && onReview(file)}
>
  <button
    class={[
      'w-3 shrink-0 text-center text-2xs text-dim',
      { invisible: !splittable, 'opacity-0 group-hover:opacity-100': !expanded }
    ]}
    title={expanded ? 'Hide hunks' : 'Show hunks'}
    aria-label={expanded ? 'Hide hunks' : 'Show hunks'}
    onclick={(event) => {
      event.stopPropagation()
      expanded = !expanded
    }}
  >
    {expanded ? '▾' : '▸'}
  </button>
  <Icon icon={iconFor(file)} width="16" height="16" class="shrink-0" />
  <span class="min-w-0 truncate" class:line-through={file.changeType === 'deleted'}>
    {baseName(file.path)}
  </span>
  {#if showDirectory && directoryName(file.path)}
    <span class="min-w-0 flex-1 truncate text-2xs text-dim">{directoryName(file.path)}</span>
  {:else}
    <span class="flex-1"></span>
  {/if}
  <div class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
    <RowAction icon={FileIcon} title="Open file" onclick={openFile} />
    {#if file.staged}
      <RowAction icon={MinusIcon} title="Unstage" disabled={busy} onclick={toggleFile} />
    {:else}
      <RowAction icon={PlusIcon} title="Stage" disabled={busy} onclick={toggleFile} />
    {/if}
  </div>
  <span
    class="w-3 shrink-0 text-center font-mono text-2xs {statusColour[file.changeType]}"
    title={file.oldPath ? `renamed from ${file.oldPath}` : file.changeType}
  >
    {file.changeType[0].toUpperCase()}
  </span>
</div>

{#if expanded}
  {#each hunks as hunk, index (`${hunk.originalStart}:${hunk.modifiedStart}`)}
    <div
      class="group flex w-full cursor-pointer items-center gap-2 py-[3px] pr-2 text-2xs select-none hover:bg-hover"
      style:padding-left="{indent + 32}px"
      role="treeitem"
      tabindex="-1"
      aria-selected="false"
      onclick={() => revealHunk(hunk)}
      onkeydown={(event) => event.key === 'Enter' && revealHunk(hunk)}
    >
      <span class="font-mono text-muted">{hunkLabel(hunk)}</span>
      {#if hunk.modifiedCount > 0}
        <span class="font-mono text-green">+{hunk.modifiedCount}</span>
      {/if}
      {#if hunk.originalCount > 0}
        <span class="font-mono text-red">−{hunk.originalCount}</span>
      {/if}
      <span class="flex-1"></span>
      <div class="hidden shrink-0 items-center group-hover:flex">
        {#if file.staged}
          <RowAction
            icon={MinusIcon}
            title="Unstage hunk"
            disabled={busy}
            onclick={() => toggleHunk(index)}
          />
        {:else}
          <RowAction
            icon={PlusIcon}
            title="Stage hunk"
            disabled={busy}
            onclick={() => toggleHunk(index)}
          />
        {/if}
      </div>
    </div>
  {:else}
    <p class="py-[3px] text-2xs text-dim" style:padding-left="{indent + 32}px">No hunks.</p>
  {/each}
{/if}
