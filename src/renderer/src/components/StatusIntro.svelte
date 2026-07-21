<script lang="ts">
  import { intro } from '../lib/intro.svelte'
  import { layout } from '../lib/layout.svelte'
  import { INTRO_PHASE_LABELS } from '../lib/intro/prompt'

  // Only nag when the session runs but the intro pane isn't showing in the dock.
  const hidden = $derived(
    intro.active && (layout.docks.left.paneType !== 'intro' || !layout.docks.left.open)
  )
</script>

{#if hidden}
  <button
    class="flex items-center gap-1 rounded bg-action/20 px-1.5 text-2xs text-action hover:bg-action/30"
    onclick={() => layout.ensurePane('intro')}
    title="AGENTS.md setup is running — click to return"
  >
    <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-action"></span>
    AGENTS.md setup · {INTRO_PHASE_LABELS[intro.phase]}
  </button>
{/if}
