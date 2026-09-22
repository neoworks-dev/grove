<script lang="ts">
  // One commit in the commits section: its subject, how old it is, and a mark
  // when it is not on the upstream yet (↑) or is on the upstream but not here
  // (↓). It expands into the files it changed; each opens that change.
  import type { Snippet } from 'svelte'
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import CommitFileRow from './CommitFileRow.svelte'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import { relativeTime } from '../../../lib/time'
  import { openCommitFileDiff } from '../../../lib/nvim/revisionDiff'
  import type { CommitSummary, DiffFile } from '../../../../../shared/types'

  let {
    worktreeId,
    commit,
    direction,
    actions = undefined
  }: {
    worktreeId: string
    commit: CommitSummary
    /** Unpushed, incoming, or neither. */
    direction: 'outgoing' | 'incoming' | null
    /** Hover actions shown before copy-SHA, for rows that are more than a commit (a stash). */
    actions?: Snippet
  } = $props()

  let expanded = $state(false)
  let files = $state<DiffFile[] | null>(null)

  /** Opens or closes the commit, fetching its files the first time. */
  async function toggle(): Promise<void> {
    expanded = !expanded
    if (!expanded || files !== null) return
    try {
      files = await window.workbench.git.commitFiles(worktreeId, commit.sha)
    } catch (err) {
      store.setError((err as Error).message)
      files = []
    }
  }

  /** Opens one of the commit's files as a diff against the commit's first parent. */
  function openFile(file: DiffFile): void {
    openCommitFileDiff(worktreeId, commit, file)
  }

  /** Puts the full sha on the clipboard. */
  function copySha(): void {
    void navigator.clipboard.writeText(commit.sha)
  }

  /** Who, when and which commit, for the row's tooltip. */
  function details(): string {
    const date = new Date(commit.date).toLocaleString()
    return `${commit.shortSha} · ${commit.authorName} · ${date}\n\n${commit.subject}`
  }
</script>

<div
  class="group/row flex w-full cursor-pointer items-center gap-1 py-[3px] pr-2 pl-1 text-xs text-muted select-none hover:bg-hover"
  role="treeitem"
  tabindex="-1"
  aria-selected="false"
  aria-expanded={expanded}
  aria-label={commit.subject}
  title={details()}
  onclick={toggle}
  onkeydown={(event) => event.key === 'Enter' && toggle()}
>
  <span class="w-3 shrink-0 text-center text-2xs text-dim">{expanded ? '▾' : '▸'}</span>
  <span class="grid w-3 shrink-0 place-items-center">
    {#if direction === 'outgoing'}
      <ArrowUpIcon size={10} class="text-green" />
    {:else if direction === 'incoming'}
      <ArrowDownIcon size={10} class="text-blue" />
    {:else}
      <span class="size-1.5 rounded-full bg-faint"></span>
    {/if}
  </span>
  <span class="min-w-0 flex-1 truncate">{commit.subject}</span>
  <div class="hidden shrink-0 items-center group-hover/row:flex">
    {#if actions}
      {@render actions()}
    {/if}
    <RowAction icon={CopyIcon} title="Copy SHA" onclick={copySha} />
  </div>
  <span class="shrink-0 font-mono text-2xs text-dim group-hover/row:hidden">
    {relativeTime(commit.date)}
  </span>
</div>

{#if expanded}
  {#if files === null}
    <p class="py-[3px] pl-9 text-2xs text-dim">Loading…</p>
  {:else}
    {#each files as file (file.path)}
      <CommitFileRow {file} depth={1} onOpen={openFile} />
    {:else}
      <p class="py-[3px] pl-9 text-2xs text-dim">No file changes.</p>
    {/each}
  {/if}
{/if}
