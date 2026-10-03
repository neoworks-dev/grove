<script lang="ts">
  // The explorer view: a header, the worktree's open files, then its file tree.
  import FileExplorer from './FileExplorer.svelte'
  import ExplorerSection from './ExplorerSection.svelte'
  import OpenFilesList from './OpenFilesList.svelte'
  import PaneControls from '../../../components/PaneControls.svelte'
  import { store, openFileInEditor } from '../../../lib/store.svelte'
  import type { FileNode } from '../../../../../shared/types'

  const openFiles = $derived(store.tabs.filter((tab) => !tab.scratch))

  /** Opens a file picked in the tree. */
  function onOpen(node: FileNode): void {
    if (store.selectedWorktreeId) openFileInEditor(store.selectedWorktreeId, node.path)
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex shrink-0 items-center gap-1.5 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Explorer</span>
    <span class="flex-1"></span>
    <PaneControls />
  </div>

  {#if store.selectedWorktreeId && store.selectedWorktree}
    {#if openFiles.length > 0}
      <ExplorerSection title="Open Files" count={openFiles.length}>
        <OpenFilesList tabs={openFiles} worktreePath={store.selectedWorktree.path} />
      </ExplorerSection>
    {/if}

    <ExplorerSection title={store.selectedWorktree.name} fill>
      {#key store.selectedWorktreeId}
        <FileExplorer worktreeId={store.selectedWorktreeId} {onOpen} />
      {/key}
    </ExplorerSection>
  {:else}
    <div class="px-3 py-2 text-2xs text-dim">Open a repository to browse files.</div>
  {/if}
</div>
