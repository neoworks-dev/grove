<script lang="ts">
  // One comment, drawn the way GitHub draws one: a bordered card with a tinted
  // header carrying the avatar, the author, when they wrote it and how they
  // relate to the repository, then the rendered body.
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import { ageLabel, reviewTone } from './filter'
  import { associationLabel } from './timeline'
  import { renderMarkdown } from '../../../lib/markdown'
  import type { GithubActor } from '../../../../../shared/types'

  let {
    author,
    association,
    body,
    at,
    reviewState,
    verb = 'commented'
  }: {
    author: GithubActor
    association: string
    body: string
    at: string
    reviewState?: string
    /** "opened" for the first card of a thread, "commented" for the rest. */
    verb?: string
  } = $props()

  const role = $derived(associationLabel(association))
  const empty = $derived(body.trim().length === 0)
</script>

<div class="overflow-hidden rounded-md border border-line-strong bg-surface">
  <div class="flex items-center gap-2 border-b border-line-strong bg-elevated px-3 py-1.5">
    <GithubAvatar actor={author} size={20} />
    <span class="truncate text-2xs font-medium text-default">{author.login}</span>
    <span class="truncate text-2xs text-dim">{verb} {ageLabel(at)}</span>
    {#if reviewState}
      <GithubBadge tone={reviewTone(reviewState)}>
        {reviewState.toLowerCase().replace('_', ' ')}
      </GithubBadge>
    {/if}
    {#if role}
      <span class="ml-auto shrink-0 rounded-full border border-line px-1.5 text-2xs text-dim">
        {role}
      </span>
    {/if}
  </div>

  <div class="px-3 py-2">
    {#if empty}
      <p class="text-xs italic text-dim">No description.</p>
    {:else}
      <div class="agent-markdown prose max-w-none text-xs text-default">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderMarkdown(body)}
      </div>
    {/if}
  </div>
</div>
