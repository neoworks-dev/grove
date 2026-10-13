<script lang="ts">
  // A strip of tape across the top edge of a paper surface. Drawn only when the
  // active theme sets a tape colour; the host must be `relative` and must not
  // clip its overflow, so it goes on a wrapper rather than on a clipped panel.
  import { store } from '../lib/store.svelte'

  const tape = $derived(store.activeTheme.shape?.tape)
</script>

{#if tape}
  <span
    aria-hidden="true"
    class="pointer-events-none absolute -top-2.5 left-1/2 z-10 h-5 w-20 -translate-x-1/2 -rotate-2 shadow-xs"
    style="background: var(--tape)"
  ></span>
{/if}
