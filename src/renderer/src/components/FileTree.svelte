<script lang="ts">
  import Self from './FileTree.svelte'
  import type { FileNode } from '../../../shared/types'
  import { store } from '../lib/store.svelte'

  let {
    worktreeId,
    relPath = '',
    depth = 0,
    onOpen
  }: {
    worktreeId: string
    relPath?: string
    depth?: number
    onOpen: (node: FileNode) => void
  } = $props()

  let nodes = $state<FileNode[]>([])
  let expanded = $state<Record<string, boolean>>({})
  let loaded = $state(false)

  async function load(): Promise<void> {
    try {
      nodes = await window.workbench.files.listDir(worktreeId, relPath)
      loaded = true
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  function toggle(node: FileNode): void {
    if (node.isDir) {
      expanded = { ...expanded, [node.path]: !expanded[node.path] }
    } else {
      onOpen(node)
    }
  }

  $effect(() => {
    // Reload when worktree or path changes.
    worktreeId
    relPath
    loaded = false
    load()
  })
</script>

<ul class="select-none">
  {#each nodes as node (node.path)}
    <li>
      <button
        class="flex w-full items-center gap-1 py-0.5 text-left text-xs hover:bg-hover {store.activeTabPath ===
        node.path
          ? 'text-default'
          : 'text-muted'}"
        style="padding-left: {depth * 12 + 8}px"
        onclick={() => toggle(node)}
      >
        <span class="w-3 shrink-0 text-dim">
          {#if node.isDir}{expanded[node.path] ? '▾' : '▸'}{/if}
        </span>
        <span class="truncate">{node.name}</span>
      </button>
      {#if node.isDir && expanded[node.path]}
        <Self {worktreeId} relPath={node.relPath} depth={depth + 1} {onOpen} />
      {/if}
    </li>
  {/each}
</ul>
