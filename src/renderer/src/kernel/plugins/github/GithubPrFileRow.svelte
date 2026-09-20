<script lang="ts">
  // One row of the pull request's file tree: a directory that folds, or a file
  // that opens, can be ticked off once read, and unfolds to the comments left on
  // it. Imports itself for the recursion, the way SplitTree does.
  import Icon from '@iconify/svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubPrFileRow from './GithubPrFileRow.svelte'
  import { fileIcon, folderIcon } from '../../../lib/icons'
  import { store } from '../../../lib/store.svelte'
  import type { GithubPrFile, GithubReviewThread } from '../../../../../shared/types'
  import type { PrFileTreeNode } from './prFileTree'

  let {
    node,
    depth = 0,
    collapsed,
    expanded,
    openPath,
    isViewed,
    isRejected,
    threadsOf,
    onToggle,
    onToggleComments,
    onOpen,
    onOpenThread,
    onToggleViewed
  }: {
    node: PrFileTreeNode
    depth?: number
    collapsed: Record<string, boolean>
    // Which files have their comments unfolded beneath them.
    expanded: Record<string, boolean>
    openPath: string | null
    isViewed: (path: string) => boolean
    isRejected: (path: string) => boolean
    threadsOf: (path: string) => GithubReviewThread[]
    onToggle: (path: string) => void
    onToggleComments: (path: string) => void
    onOpen: (file: GithubPrFile) => void
    onOpenThread: (thread: GithubReviewThread) => void
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
  const rejected = $derived(node.kind === 'file' && isRejected(node.path))
  const threads = $derived(node.kind === 'file' ? threadsOf(node.path) : [])
  const showThreads = $derived(threads.length > 0 && expanded[node.path])

  // Rows indent by depth; the tree is shallow because single-child directory
  // chains are folded into one row before it gets here. The tick sits in a
  // column of its own to the left of all of it, so the indent still reads as
  // the tree it is.
  const indent = $derived(`padding-left: ${depth * 12}px`)
  const threadIndent = $derived(`padding-left: ${28 + (depth + 1) * 12}px`)

  /** Icon for a row, tracking the active icon pack. */
  function iconFor(entry: PrFileTreeNode): string {
    store.iconPack
    if (entry.kind === 'directory') return folderIcon(entry.name, isOpen)
    return fileIcon(entry.name)
  }
</script>

{#if node.kind === 'directory'}
  <div class="flex w-full items-center text-2xs hover:bg-hover">
    <!-- The tick column, empty here, so file names line up under directories. -->
    <span class="w-7 shrink-0"></span>
    <button
      class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-4 text-left"
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
  </div>
  {#if isOpen}
    {#each node.children as child (child.path)}
      <GithubPrFileRow
        node={child}
        depth={depth + 1}
        {collapsed}
        {expanded}
        {openPath}
        {isViewed}
        {isRejected}
        {threadsOf}
        {onToggle}
        {onToggleComments}
        {onOpen}
        {onOpenThread}
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
    <input
      type="checkbox"
      class="ml-2 mr-1 shrink-0 accent-accent"
      checked={viewed}
      aria-label="Reviewed {node.path}"
      title={viewed ? 'Reviewed — untick to read again' : 'Mark as reviewed'}
      onchange={(event) => onToggleViewed(node.file, event.currentTarget.checked)}
    />
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
      {#if rejected}
        <GithubBadge tone="red" title="You have asked for changes to this file">✗</GithubBadge>
      {/if}
      {#if node.file.binary}
        <GithubBadge tone="dim">binary</GithubBadge>
      {:else}
        <GithubBadge tone="green">+{node.file.added}</GithubBadge>
        <GithubBadge tone="red">−{node.file.removed}</GithubBadge>
      {/if}
    </button>
    {#if threads.length > 0}
      <button
        class="shrink-0 rounded px-1 py-0.5 font-mono text-2xs hover:bg-hover"
        class:text-blue={threads.some((thread) => thread.pending)}
        class:text-dim={!threads.some((thread) => thread.pending)}
        title="{threads.length} comment{threads.length === 1 ? '' : 's'} — click to list them"
        onclick={() => onToggleComments(node.path)}
      >
        {showThreads ? '▾' : '▸'}{threads.length}
      </button>
    {/if}
  </div>
  {#if showThreads}
    {#each threads as thread (thread.id)}
      <button
        class="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left text-2xs hover:bg-hover"
        style={threadIndent}
        title="Go to this comment"
        onclick={() => onOpenThread(thread)}
      >
        <span class="w-8 shrink-0 font-mono text-dim">
          {thread.line === null ? 'file' : `L${thread.line}`}
        </span>
        {#if thread.comments[0]}
          <span class="shrink-0 text-dim">{thread.comments[0].author.login}</span>
        {/if}
        <span class="min-w-0 flex-1 truncate text-muted">
          {thread.comments[0] ? thread.comments[0].body : ''}
        </span>
        {#if thread.comments.length > 1}
          <GithubBadge tone="dim">+{thread.comments.length - 1}</GithubBadge>
        {/if}
        {#if thread.pending}
          <GithubBadge tone="blue" title="Not submitted yet">draft</GithubBadge>
        {/if}
        {#if thread.isResolved}
          <GithubBadge tone="dim">resolved</GithubBadge>
        {/if}
      </button>
    {/each}
  {/if}
{/if}
