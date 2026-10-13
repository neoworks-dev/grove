<script lang="ts">
  // The active theme's mascot, decorative only: it sits beside text that already
  // says what is going on, so it carries no alt text. Nothing is drawn when the
  // setting is off or the theme has no image for the pose.
  import { store } from '../lib/store.svelte'
  import { settings } from '../lib/settings.svelte'
  import { resolveMascotUrl } from '../lib/mascot'

  let { pose, class: className = '' }: { pose: string; class?: string } = $props()

  const url = $derived(
    resolveMascotUrl(store.activeTheme, pose, settings.get<boolean>('workbench.showMascot'))
  )
</script>

{#if url}
  <img src={url} alt="" draggable="false" class="pointer-events-none select-none {className}" />
{/if}
