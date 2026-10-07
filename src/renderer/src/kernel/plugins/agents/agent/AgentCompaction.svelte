<script lang="ts">
  // A compaction of the agent's context, as one row from start to end: the
  // working mark while the harness shrinks the conversation, then the outcome.
  // A finished one opens onto the summary the conversation was reduced to,
  // which is all the agent remembers of what came before it.
  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import BusySpark from '../../../../components/BusySpark.svelte'
  import ShimmerText from '../../../../components/ShimmerText.svelte'
  import { renderMarkdown } from '../../../../lib/markdown'
  import { compactionLabel } from '../../../../lib/agents/compaction'
  import type { CompactionItem } from '../../../../lib/agents/transcript'

  let { item }: { item: CompactionItem } = $props()

  let open = $state(false)

  const label = $derived(compactionLabel(item))

  /** A failed compaction reads as an error; anything else as grove's own notes do. */
  function toneOf(status: CompactionItem['status']): string {
    if (status === 'failed') return 'border-red/30 bg-red-soft text-red'
    return 'border-line bg-elevated text-muted'
  }
</script>

<div class="-mx-3 mb-3 border-y px-3 py-2 text-2xs {toneOf(item.status)}">
  {#if item.status === 'running'}
    <div class="flex items-center gap-2">
      <span class="shrink-0 text-green"><BusySpark /></span>
      <ShimmerText text={label} class="min-w-0 truncate" />
    </div>
  {:else if item.summary}
    <button
      class="flex w-full min-w-0 items-center gap-2 text-left"
      onclick={() => (open = !open)}
      title="Show the summary the conversation was reduced to"
    >
      <span
        class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
        class:rotate-90={open}
      >
        <CaretRight width="10" height="10" weight="bold" />
      </span>
      <span class="min-w-0 flex-1">{label}</span>
    </button>
    {#if open}
      <div class="agent-markdown agent-thinking prose mt-2 max-w-none">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderMarkdown(item.summary)}
      </div>
    {/if}
  {:else}
    <span class="whitespace-pre-wrap">{label}</span>
  {/if}
</div>
