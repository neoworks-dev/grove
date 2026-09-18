<script lang="ts">
  // One row of the issue / pull-request list: state dot, number, title, then the
  // signals that decide whether an item needs attention (labels, checks, review,
  // diff size, comment count, age).
  import GithubBadge from './GithubBadge.svelte'
  import {
    checkGlyph,
    checkTone,
    labelIsDark,
    relativeTime,
    reviewLabel,
    reviewTone,
    stateTone
  } from './filter'
  import type { GithubItem } from '../../../../../shared/types'

  let {
    item,
    selected,
    isViewer,
    onselect
  }: {
    item: GithubItem
    selected: boolean
    /** The signed-in user authored this item. */
    isViewer: boolean
    onselect: () => void
  } = $props()

  const tone = $derived(stateTone(item))
  const review = $derived(item.kind === 'pull' ? reviewLabel(item.reviewDecision) : null)
  const checks = $derived(item.kind === 'pull' ? checkGlyph(item.checks) : null)
</script>

<button
  class="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left hover:bg-hover"
  class:bg-hover={selected}
  aria-selected={selected}
  onclick={onselect}
>
  <span
    class="h-2 w-2 shrink-0 rounded-full"
    class:bg-green={tone === 'green'}
    class:bg-red={tone === 'red'}
    class:bg-violet={tone === 'violet'}
    class:bg-dim={tone === 'dim'}
    title={item.state.toLowerCase()}
  ></span>

  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-2">
      <span class="shrink-0 font-mono text-2xs text-dim">#{item.number}</span>
      <span class="min-w-0 flex-1 truncate text-xs text-default">{item.title}</span>
      <span class="shrink-0 font-mono text-2xs text-dim">{relativeTime(item.updatedAt)}</span>
    </div>

    <div class="mt-1 flex items-center gap-2">
      <span class="shrink-0 text-2xs" class:text-violet={isViewer} class:text-dim={!isViewer}>
        {item.author}
      </span>

      {#if item.kind === 'pull'}
        {#if item.isDraft}
          <GithubBadge tone="dim">draft</GithubBadge>
        {/if}
        <GithubBadge tone="green">+{item.additions}</GithubBadge>
        <GithubBadge tone="red">−{item.deletions}</GithubBadge>
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
        <GithubBadge tone="dim" title="{item.commentCount} comments">
          ⌯{item.commentCount}
        </GithubBadge>
      {/if}

      <span class="flex min-w-0 flex-1 justify-end gap-1 overflow-hidden">
        {#each item.labels.slice(0, 3) as label (label.name)}
          <span
            class="shrink-0 truncate rounded-full px-1.5 text-2xs"
            class:text-white={labelIsDark(label.color)}
            class:text-black={!labelIsDark(label.color)}
            style:background-color="#{label.color}"
          >
            {label.name}
          </span>
        {/each}
      </span>
    </div>
  </div>
</button>
