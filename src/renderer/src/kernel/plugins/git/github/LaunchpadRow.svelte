<script lang="ts">
  // One Launchpad row, laid out in the columns GitKraken's Launchpad uses: a
  // pin, how long since it last moved, its status as icons, then the item with
  // its diff size and labels, and on a wide pane who opened it, who has it and
  // its branch.
  //
  // A div rather than a button, like the list's row: it holds its own controls.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon'
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon'
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon'
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon'
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubStateIcon from './GithubStateIcon.svelte'
  import { assigneeLogins, relativeTime } from './filter'
  import { prefetchItem } from './store.svelte'
  import type { GithubItem } from '../../../../../../shared/types'

  let {
    item,
    columns,
    wide,
    selected,
    checked,
    pinned,
    pinnedOnGithub,
    onselect,
    ontoggle,
    onpin
  }: {
    item: GithubItem
    /** The grid's column template, shared with the header so they line up. */
    columns: string
    /** Room for the author, assignee and branch columns. */
    wide: boolean
    /** This row's thread is the one open on the right. */
    selected: boolean
    /** This row is ticked for a bulk action. */
    checked: boolean
    pinned: boolean
    /** Pinned on GitHub's issue list, which only GitHub can undo. */
    pinnedOnGithub: boolean
    onselect: () => void
    ontoggle: () => void
    onpin: () => void
  } = $props()

  const author = $derived({ login: item.author, avatarUrl: avatarFor(item.author) })

  /** The list query carries no avatar URLs, so one is built from the login, as the list row does. */
  function avatarFor(login: string): string | null {
    if (login === 'ghost') return null
    if (login.includes('[')) return null
    return `https://github.com/${login}.png`
  }

  /** What the pin button says it will do. */
  function pinTitle(): string {
    if (pinnedOnGithub) return 'Pinned on GitHub'
    if (pinned) return 'Unpin'
    return 'Pin to the top'
  }

  /** Keyboard equivalent of clicking the row. */
  function onRowKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onselect()
  }

  /** Keeps a click on one of the row's own controls from opening the item. */
  function stop(event: Event): void {
    event.stopPropagation()
  }
</script>

<div
  class="grid cursor-pointer items-center gap-2 border-b border-l-2 border-line px-2 py-1.5 text-xs transition-colors duration-100 hover:bg-hover"
  class:bg-elevated={selected}
  class:border-l-action={selected}
  class:border-l-transparent={!selected}
  style:grid-template-columns={columns}
  role="button"
  tabindex="0"
  aria-current={selected}
  onclick={onselect}
  onmouseenter={() => prefetchItem(item.kind, item.number)}
  onkeydown={onRowKey}
>
  <span class="flex" role="presentation" onclick={stop} onkeydown={stop}>
    <Checkbox size="sm" {checked} onchange={ontoggle} aria-label="Select #{item.number}" />
  </span>

  <button
    class="grid size-5 place-items-center rounded hover:bg-raised hover:text-default disabled:cursor-default"
    class:text-default={pinned || pinnedOnGithub}
    class:text-faint={!pinned && !pinnedOnGithub}
    title={pinTitle()}
    aria-label={pinTitle()}
    aria-pressed={pinned || pinnedOnGithub}
    disabled={pinnedOnGithub}
    onclick={(event) => {
      stop(event)
      onpin()
    }}
  >
    <PushPinIcon size={12} weight={pinned || pinnedOnGithub ? 'fill' : 'regular'} />
  </button>

  <span class="font-mono text-2xs text-dim" title="Updated {item.updatedAt}">
    {relativeTime(item.updatedAt)}
  </span>

  <span class="flex items-center gap-1">
    <GithubStateIcon {item} />
    {#if item.kind === 'pull'}
      {#if item.checks === 'SUCCESS'}
        <span class="text-green" title="Checks passed"><CheckCircleIcon size={13} /></span>
      {:else if item.checks === 'FAILURE' || item.checks === 'ERROR'}
        <span class="text-red" title="Checks failed"><XCircleIcon size={13} /></span>
      {:else if item.checks}
        <span class="text-amber" title="Checks running"><ClockIcon size={13} /></span>
      {/if}
      {#if item.reviewDecision === 'APPROVED'}
        <span class="text-green" title="Approved"><EyeIcon size={13} /></span>
      {:else if item.reviewDecision === 'CHANGES_REQUESTED'}
        <span class="text-red" title="Changes requested"><PencilSimpleIcon size={13} /></span>
      {:else if item.reviewDecision === 'REVIEW_REQUIRED'}
        <span class="text-dim" title="Review required"><EyeIcon size={13} /></span>
      {/if}
    {/if}
  </span>

  <span class="min-w-0">
    <span class="flex min-w-0 items-baseline gap-1.5">
      <span class="truncate font-medium text-default">{item.title}</span>
      <span class="shrink-0 font-mono text-2xs text-action">#{item.number}</span>
    </span>
    {#if item.kind === 'pull' || item.labels.length > 0}
      <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {#if item.kind === 'pull'}
          <span class="font-mono text-2xs">
            <span class="text-green">+{item.additions}</span>
            <span class="text-red">−{item.deletions}</span>
          </span>
        {/if}
        {#each item.labels as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
      </span>
    {/if}
  </span>

  {#if wide}
    <span class="flex" title={item.author}>
      <GithubAvatar actor={author} size={16} />
    </span>

    <span class="flex items-center -space-x-1" title={assigneeLogins(item).join(', ')}>
      {#each item.assignees as assignee (assignee.login)}
        <GithubAvatar actor={assignee} size={16} />
      {/each}
    </span>

    <span class="flex min-w-0 items-center gap-1 text-2xs text-dim">
      {#if item.kind === 'pull'}
        <GitBranchIcon size={11} class="shrink-0" />
        <span class="truncate font-mono" title={item.headRefName}>{item.headRefName}</span>
      {/if}
    </span>
  {/if}
</div>
