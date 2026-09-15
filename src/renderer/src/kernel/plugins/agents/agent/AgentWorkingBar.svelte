<script lang="ts">
  // The one place grove says a turn is in flight: a spark, a line that rotates
  // while you wait, and the token count. The bar only exists while the agent is
  // working, so it picks a fresh line every time it appears.
  import BusySpark from '../../../../components/BusySpark.svelte'
  import ShimmerText from '../../../../components/ShimmerText.svelte'
  import { nextWorkingPhrase } from '../../../../lib/agents/workingPhrases'

  let { tokensLabel }: { tokensLabel: string } = $props()

  // Long enough to read twice and not notice the swap; short enough that a long
  // turn does not sit on one joke.
  const PHRASE_INTERVAL_MS = 4_000

  let phrase = $state(nextWorkingPhrase(''))

  $effect(() => {
    const timer = setInterval(() => {
      phrase = nextWorkingPhrase(phrase)
    }, PHRASE_INTERVAL_MS)
    return () => clearInterval(timer)
  })
</script>

<div class="flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-3 py-1.5 text-2xs">
  <span class="shrink-0 text-green"><BusySpark /></span>
  <ShimmerText text="{phrase}…" class="min-w-0 truncate" />
  <span
    class="ml-auto shrink-0 font-mono text-muted"
    title="context window fill + output of the latest turn">{tokensLabel} tok</span
  >
</div>
