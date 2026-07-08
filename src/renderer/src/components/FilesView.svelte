<script lang="ts">
  import FileExplorer from './FileExplorer.svelte'
  import { store, openFileInEditor } from '../lib/store.svelte'
  import type { FileNode } from '../../../shared/types'

  function onOpen(node: FileNode): void {
    if (store.selectedWorktreeId) openFileInEditor(store.selectedWorktreeId, node.path)
  }
</script>

{#if store.selectedWorktreeId}
  {#key store.selectedWorktreeId}
    <FileExplorer worktreeId={store.selectedWorktreeId} {onOpen} />
  {/key}
{:else}
  <div class="px-3 py-2 text-2xs text-dim">Open a repository to browse files.</div>
{/if}
