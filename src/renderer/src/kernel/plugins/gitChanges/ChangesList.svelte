<script lang="ts" module>
  import type { DiffFile } from '../../../../../shared/types'

  /** Identifies a file within the view: staged and unstaged halves of one path differ. */
  export function fileKey(file: DiffFile): string {
    if (file.staged) return `S:${file.path}`
    return `U:${file.path}`
  }
</script>

<script lang="ts">
  // The files of one changes section, laid out as a tree or a list. Folder
  // collapse state is kept per section, so collapsing `src` under Staged leaves
  // it open under Changes.
  import { SvelteSet } from 'svelte/reactivity'
  import ChangeFileRow from './ChangeFileRow.svelte'
  import ChangeFolderRow from './ChangeFolderRow.svelte'
  import { store } from '../../../lib/store.svelte'
  import { changeRows, type ChangeRow, type ChangesLayout, type FolderRow } from './changeTree'

  let {
    worktreeId,
    files,
    staged,
    layout,
    selectedKey,
    refreshKey,
    onReview,
    onChanged
  }: {
    worktreeId: string
    files: DiffFile[]
    staged: boolean
    layout: ChangesLayout
    selectedKey: string | null
    refreshKey: number
    onReview: (file: DiffFile) => void
    onChanged: () => void
  } = $props()

  const collapsed = new SvelteSet<string>()
  let busy = $state(false)

  const rows = $derived(changeRows(files, layout, collapsed))

  /** Keys a row by kind and path, so a folder and a file of one name never clash. */
  function rowKey(row: ChangeRow): string {
    if (row.kind === 'folder') return `d:${row.path}`
    return `f:${row.file.path}`
  }

  /** Collapses an open folder or opens a collapsed one. */
  function toggleCollapsed(folder: FolderRow): void {
    if (collapsed.has(folder.path)) collapsed.delete(folder.path)
    else collapsed.add(folder.path)
  }

  /** Stages, or unstages, every file under a folder. */
  async function toggleFolder(folder: FolderRow): Promise<void> {
    const prefix = `${folder.path}/`
    const paths = files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path)
    busy = true
    try {
      if (staged) await window.workbench.git.unstage(worktreeId, paths)
      else await window.workbench.git.stage(worktreeId, paths)
      onChanged()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }
</script>

<div role="tree">
  {#each rows as row (rowKey(row))}
    {#if row.kind === 'folder'}
      <ChangeFolderRow
        {row}
        {staged}
        {busy}
        collapsed={collapsed.has(row.path)}
        onToggleCollapsed={() => toggleCollapsed(row)}
        onToggleStaged={() => toggleFolder(row)}
      />
    {:else}
      <ChangeFileRow
        {worktreeId}
        file={row.file}
        depth={row.depth}
        showDirectory={layout === 'list'}
        selected={selectedKey === fileKey(row.file)}
        {refreshKey}
        {onReview}
        {onChanged}
      />
    {/if}
  {/each}
</div>
