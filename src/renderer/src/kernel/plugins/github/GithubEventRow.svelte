<script lang="ts">
  // The sentence of a non-comment row: who did what, when. The icon belongs to
  // the rail and is rendered by the row wrapper, so this is only the text.
  //
  // Label changes arrive already folded, so one edit that applied three labels
  // is one sentence with three pills rather than three near-identical rows.
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import { ageLabel } from './filter'
  import { openReference } from './store.svelte'
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
      <!-- Opens in the pane. This is a GitHub client; leaving it to read the
           issue next door defeats the point, and the browser is a click away
           under "Open on GitHub" when that is what is wanted. -->
      <button
        class="truncate font-mono text-default underline-offset-2 hover:underline"
        title={event.source.title}
        onclick={() => {
          const source = event?.source
          if (source) void openReference(source.kind, source.number)
        }}
      >
        #{event.source.number}
      </button>
      <span class="truncate">{event.source.title}</span>
    {/if}
  {/if}

  <span>{ageLabel(at)}</span>
</p>
