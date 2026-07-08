<script lang="ts">
  import Self from './FileTree.svelte'
  import Icon from '@iconify/svelte'
  import type { FileNode } from '../../../shared/types'
  import { store } from '../lib/store.svelte'
  import { fileIcon, folderIcon } from '../lib/icons'

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

  async function load(): Promise<void> {
    try {
      nodes = await window.workbench.files.listDir(worktreeId, relPath)
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

  // Resolve icon; reading store.iconPack makes this re-run when the pack changes.
  function iconFor(node: FileNode): string {
    store.iconPack
    return node.isDir ? folderIcon(node.name, !!expanded[node.path]) : fileIcon(node.name)
  }

  // Reload on worktree/path change and whenever the worktree's files change.
  $effect(() => {
    worktreeId
    relPath
    store.fsVersion[worktreeId]
    void load()
  })
</script>

<ul class="select-none">
  {#each nodes as node (node.path)}
    <li>
      <button
        class="flex w-full items-center gap-1 rounded py-[3px] pr-2 text-left text-xs hover:bg-hover {store.activeTabPath ===
        node.path
          ? 'bg-hover text-default'
          : 'text-muted'}"
        style="padding-left: {depth * 12 + 6}px"
        onclick={() => toggle(node)}
      >
        <span class="w-3 shrink-0 text-center text-2xs text-dim">
          {#if node.isDir}{expanded[node.path] ? '▾' : '▸'}{/if}
        </span>
        <Icon icon={iconFor(node)} width="16" height="16" class="shrink-0" />
        <span class="truncate">{node.name}</span>
      </button>
      {#if node.isDir && expanded[node.path]}
        <Self {worktreeId} relPath={node.relPath} depth={depth + 1} {onOpen} />
      {/if}
    </li>
  {/each}
</ul>
