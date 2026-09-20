<script lang="ts">
  // One row of the pull request's file tree: a directory that folds, or a file
  // that opens and can be ticked off once read. Imports itself for the
  // recursion, the way SplitTree does.
  import Icon from '@iconify/svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubPrFileRow from './GithubPrFileRow.svelte'
  import { fileIcon, folderIcon } from '../../../lib/icons'
  import { store } from '../../../lib/store.svelte'
  import type { GithubPrFile } from '../../../../../shared/types'
  import type { PrFileTreeNode } from './prFileTree'

  let {
    node,
    depth = 0,
    collapsed,
    openPath,
    isViewed,
    onToggle,
    onOpen,
    onToggleViewed
  }: {
    node: PrFileTreeNode
    depth?: number
    collapsed: Record<string, boolean>
    openPath: string | null
    isViewed: (path: string) => boolean
    onToggle: (path: string) => void
    onOpen: (file: GithubPrFile) => void
    onToggleViewed: (file: GithubPrFile, viewed: boolean) => void
  } = $props()

  const statusLetters: Record<GithubPrFile['changeType'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    untracked: 'A'
  }

  const isOpen = $derived(node.kind === 'directory' && !collapsed[node.path])
  const viewed = $derived(node.kind === 'file' && isViewed(node.path))

  // Rows indent by depth; the tree is shallow because single-child directory
  // chains are folded into one row before it gets here.
  const indent = $derived(`padding-left: ${12 + depth * 12}px`)

  /** Icon for a row, tracking the active icon pack. */
  function iconFor(entry: PrFileTreeNode): string {
    store.iconPack
    if (entry.kind === 'directory') return folderIcon(entry.name, isOpen)
    return fileIcon(entry.name)
  }
</script>

{#if node.kind === 'directory'}
  <button
    class="flex w-full items-center gap-1.5 py-1 pr-4 text-left text-2xs hover:bg-hover"
    style={indent}
    onclick={() => onToggle(node.path)}
  >
    <!-- The file explorer's caret: a glyph, because only the file-icon
         collections are registered offline and anything else reaches for the
         network. -->
    <span class="w-2.5 shrink-0 text-center text-dim">{isOpen ? '▾' : '▸'}</span>
    <Icon icon={iconFor(node)} width="14" height="14" class="shrink-0" />
    <span class="min-w-0 flex-1 truncate font-mono text-muted" title={node.path}>{node.name}</span>
  </button>
  {#if isOpen}
    {#each node.children as child (child.path)}
      <GithubPrFileRow
        node={child}
        depth={depth + 1}
        {collapsed}
        {openPath}
        {isViewed}
        {onToggle}
        {onOpen}
        {onToggleViewed}
      />
    {/each}
  {/if}
{:else}
  <!-- The tick is its own control beside the row rather than inside it: a
       checkbox nested in a button is neither valid nor reachable. -->
  <div
    class="flex w-full items-center gap-1.5 pr-3 text-2xs hover:bg-hover"
    class:bg-hover={openPath === node.path}
  >
    <button
      class="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      class:opacity-50={viewed}
      style={indent}
      onclick={() => onOpen(node.file)}
    >
      <!-- Sits where a directory's caret is, so names line up down the column. -->
      <span class="w-2.5 shrink-0 text-center font-mono text-dim">
        {statusLetters[node.file.changeType]}
      </span>
      <Icon icon={iconFor(node)} width="14" height="14" class="shrink-0" />
      <span class="min-w-0 flex-1 truncate font-mono text-default" title={node.path}>
        {node.name}
      </span>
      {#if node.file.binary}
        <GithubBadge tone="dim">binary</GithubBadge>
      {:else}
        <GithubBadge tone="green">+{node.file.added}</GithubBadge>
        <GithubBadge tone="red">−{node.file.removed}</GithubBadge>
      {/if}
    </button>
    <input
      type="checkbox"
      class="shrink-0 accent-accent"
      checked={viewed}
      aria-label="Reviewed {node.path}"
      title={viewed ? 'Reviewed — untick to read again' : 'Mark as reviewed'}
      onchange={(event) => onToggleViewed(node.file, event.currentTarget.checked)}
    />
  </div>
{/if}
