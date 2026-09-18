<script lang="ts">
  // One row of the list, shaped like GitHub's: a tick box, the state as an
  // icon, then the title with its labels running on from it, and underneath
  // the number, who opened it and when. Counts and signals sit on the right.
  //
  // The row is a div rather than a button because it holds its own controls —
  // a checkbox inside a button is not something the browser will let you click.
  // It still behaves like one: the whole row opens the item, and the tick box
  // stops the click so selecting rows never navigates away from what you are
  // reading.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubStateIcon from './GithubStateIcon.svelte'
  import { checkGlyph, checkTone, relativeTime, reviewLabel, reviewTone } from './filter'
  import type { GithubItem } from '../../../../../shared/types'

  let {
    item,
    selected,
    checked,
    isViewer,
    onselect,
    ontoggle
  }: {
    item: GithubItem
    /** This row's thread is the one open on the right. */
    selected: boolean
    /** This row is ticked for a bulk action. */
    checked: boolean
    /** The signed-in user authored this item. */
    isViewer: boolean
    onselect: () => void
    ontoggle: () => void
  } = $props()

  const review = $derived(item.kind === 'pull' ? reviewLabel(item.reviewDecision) : null)
  const checks = $derived(item.kind === 'pull' ? checkGlyph(item.checks) : null)

  const author = $derived({ login: item.author, avatarUrl: avatarFor(item.author) })

  /**
   * The list query carries no avatar URLs, so the byline builds one from the
   * login — GitHub redirects that to the real avatar host. A login it cannot
   * resolve this way (a bot, whose name has brackets) falls back to initials.
   */
  function avatarFor(login: string): string | null {
    if (login === 'ghost') return null
    if (login.includes('[')) return null
    return `https://github.com/${login}.png`
  }

  /** Keyboard equivalent of clicking the row. */
  function onRowKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onselect()
  }
</script>

<div
  class="flex cursor-pointer items-start gap-2 border-b border-line border-l-2 px-2 py-1.5 transition-colors duration-100 hover:bg-hover"
  class:bg-elevated={selected}
  class:border-l-action={selected}
  class:border-l-transparent={!selected}
  role="button"
  tabindex="0"
  aria-current={selected}
  onclick={onselect}
  onkeydown={onRowKey}
>
  <span
    class="mt-0.5 shrink-0"
    role="presentation"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
    <Checkbox size="sm" {checked} onchange={ontoggle} aria-label="Select #{item.number}" />
  </span>

  <span class="mt-px shrink-0">
    <GithubStateIcon {item} />
  </span>

  <div class="min-w-0 flex-1">
    <span class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span class="text-xs font-medium text-default">{item.title}</span>
      {#each item.labels as label (label.name)}
        <GithubLabelPill {label} />
      {/each}
    </span>

    <span class="mt-0.5 flex items-center gap-1.5 text-2xs text-dim">
      <span class="font-mono">#{item.number}</span>
      <span>·</span>
      <GithubAvatar actor={author} size={14} />
      <span class:text-violet={isViewer}>{item.author}</span>
      <span>opened {relativeTime(item.createdAt)} ago</span>
    </span>
  </div>

  <span class="mt-0.5 flex shrink-0 items-center gap-2">
    {#if item.kind === 'pull'}
      {#if item.isDraft}
        <GithubBadge tone="dim">draft</GithubBadge>
      {/if}
      {#if checks}
        <GithubBadge tone={checkTone(item.checks)} title="checks {item.checks}">
          {checks}
        </GithubBadge>
      {/if}
      {#if review}
        <GithubBadge tone={reviewTone(item.reviewDecision)}>{review}</GithubBadge>
      {/if}
    {/if}

    {#if item.commentCount > 0}
      <span
        class="flex items-center gap-0.5 text-2xs text-dim"
        title="{item.commentCount} comments"
      >
        <ChatCircleIcon size={11} />
        {item.commentCount}
      </span>
    {/if}
  </span>
</div>
