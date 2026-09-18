<script lang="ts">
  // One non-comment row of the timeline: a small icon on the rail, the actor,
  // and a sentence saying what they did. Label changes arrive already folded,
  // so a single edit that applied three labels is one row with three pills.
  import TagIcon from 'phosphor-svelte/lib/TagIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon'
  import UserIcon from 'phosphor-svelte/lib/UserIcon'
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon'
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon'
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import { ageLabel } from './filter'
  import type { TimelineRow } from './timeline'
  import type { GithubTimelineEvent } from '../../../../../shared/types'

  let { row }: { row: TimelineRow } = $props()

  // Narrowed once here so the markup can read straight off them.
  const labelRow = $derived(row.kind === 'labels' ? row : null)
  const event = $derived.by<GithubTimelineEvent | null>(() => {
    if (row.kind !== 'event') return null
    return row.entry.event
  })

  const actor = $derived.by(() => {
    if (labelRow) return labelRow.actor
    if (event) return event.actor
    return { login: 'ghost', avatarUrl: null }
  })

  const at = $derived.by(() => {
    if (labelRow) return labelRow.at
    if (row.kind === 'event') return row.entry.at
    return ''
  })

  function openInBrowser(url: string | undefined): void {
    if (!url) return
    void window.workbench.openExternal(url)
  }

  /** A closed issue says why when GitHub recorded a reason. */
  function closedPhrase(current: GithubTimelineEvent): string {
    if (current.stateReason === 'NOT_PLANNED') return 'closed this as not planned'
    return 'closed this'
  }

  const phrase = $derived.by<string>(() => {
    if (!event) return ''
    if (event.kind === 'closed') return closedPhrase(event)
    if (event.kind === 'reopened') return 'reopened this'
    if (event.kind === 'merged') return `merged this into ${event.mergeRefName}`
    if (event.kind === 'assigned') return `assigned ${event.subject}`
    if (event.kind === 'unassigned') return `unassigned ${event.subject}`
    if (event.kind === 'review_requested') return `requested a review from ${event.subject}`
    if (event.kind === 'renamed') return `renamed this from "${event.previousTitle}"`
    if (event.kind === 'referenced') return 'referenced this in'
    return ''
  })
</script>

<div class="flex items-start gap-2 py-1.5 pl-1">
  <span
    class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-dim"
  >
    {#if labelRow}
      <TagIcon size={11} />
    {:else if event?.kind === 'closed'}
      {#if event.stateReason === 'NOT_PLANNED'}
        <ProhibitIcon size={11} />
      {:else}
        <CheckCircleIcon size={11} />
      {/if}
    {:else if event?.kind === 'reopened'}
      <ArrowCounterClockwiseIcon size={11} />
    {:else if event?.kind === 'merged'}
      <GitMergeIcon size={11} />
    {:else if event?.kind === 'renamed'}
      <PencilSimpleIcon size={11} />
    {:else if event?.kind === 'referenced'}
      <LinkIcon size={11} />
    {:else if event?.kind === 'review_requested'}
      <EyeIcon size={11} />
    {:else}
      <UserIcon size={11} />
    {/if}
  </span>

  <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-dim">
    <GithubAvatar {actor} size={16} />
    <span class="font-medium text-default">{actor.login}</span>

    {#if labelRow}
      {#if labelRow.added.length > 0}
        <span>added</span>
        {#each labelRow.added as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
      {/if}
      {#if labelRow.added.length > 0 && labelRow.removed.length > 0}
        <span>and</span>
      {/if}
      {#if labelRow.removed.length > 0}
        <span>removed</span>
        {#each labelRow.removed as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
      {/if}
    {:else}
      <span>{phrase}</span>
      {#if event?.kind === 'referenced' && event.source}
        <!-- A bare href would navigate the whole renderer away from the app. -->
        <button
          class="truncate text-default underline-offset-2 hover:underline"
          title={event.source.title}
          onclick={() => openInBrowser(event.source?.url)}
        >
          #{event.source.number}
        </button>
      {/if}
    {/if}

    <span>{ageLabel(at)}</span>
  </p>
</div>
