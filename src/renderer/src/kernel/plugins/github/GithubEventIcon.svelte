<script lang="ts">
  // The glyph a timeline row shows on the rail. Split out so the row wrapper
  // owns the rail and this owns only which picture to draw.
  import TagIcon from 'phosphor-svelte/lib/TagIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon'
  import UserIcon from 'phosphor-svelte/lib/UserIcon'
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon'
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon'
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon'
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon'
  import type { TimelineRow } from './timeline'

  let { row }: { row: TimelineRow } = $props()

  const kind = $derived.by<string>(() => {
    if (row.kind === 'labels') return 'labeled'
    if (row.kind === 'comment') return 'comment'
    return row.entry.event.kind
  })

  const reason = $derived.by<string | undefined>(() => {
    if (row.kind !== 'event') return undefined
    return row.entry.event.stateReason
  })
</script>

{#if kind === 'labeled'}
  <TagIcon size={11} />
{:else if kind === 'comment'}
  <ChatCircleIcon size={11} />
{:else if kind === 'closed'}
  {#if reason === 'NOT_PLANNED'}
    <ProhibitIcon size={11} />
  {:else}
    <CheckCircleIcon size={11} />
  {/if}
{:else if kind === 'reopened'}
  <ArrowCounterClockwiseIcon size={11} />
{:else if kind === 'merged'}
  <GitMergeIcon size={11} />
{:else if kind === 'renamed'}
  <PencilSimpleIcon size={11} />
{:else if kind === 'referenced'}
  <LinkIcon size={11} />
{:else if kind === 'review_requested'}
  <EyeIcon size={11} />
{:else}
  <UserIcon size={11} />
{/if}
