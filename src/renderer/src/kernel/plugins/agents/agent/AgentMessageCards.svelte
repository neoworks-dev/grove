<script lang="ts">
  // The cards under one agent message: whatever the registered sources find it
  // referring to, each drawn by the feature that knows what it is.
  import { MAX_CARDS_PER_SOURCE, messageCards } from '../../../../lib/agents/messageCards.svelte'

  let { text }: { text: string } = $props()

  const found = $derived(
    messageCards.sources.map((source) => ({
      source,
      references: source.find(text).slice(0, MAX_CARDS_PER_SOURCE)
    }))
  )
</script>

{#each found as entry (entry.source.id)}
  {#each entry.references as reference (reference)}
    <entry.source.component {reference} />
  {/each}
{/each}
