<script lang="ts">
  import { statusBar } from '../lib/statusbar.svelte'
  import { store } from '../lib/store.svelte'
  import { settings } from '../lib/settings.svelte'
  import { activeLandscape } from '../lib/landscape'

  const left = $derived(statusBar.left)
  const right = $derived(statusBar.right)

  // The window's landscape runs behind the status bar, so its text needs a
  // backing to stay readable over the front ridge.
  const overLandscape = $derived(
    activeLandscape(store.activeTheme, settings.get<boolean>('workbench.showMascot')) !== undefined
  )
</script>

<footer
  class="flex h-6 shrink-0 items-center gap-3 px-1 text-2xs text-muted {overLandscape
    ? 'rounded-md border border-line-faint bg-elevated'
    : ''}"
>
  <div class="flex items-center gap-3">
    {#each left as item (item.id)}
      <item.component {...item.props ?? {}} />
    {/each}
  </div>
  <div class="ml-auto flex items-center gap-3">
    {#each right as item (item.id)}
      <item.component {...item.props ?? {}} />
    {/each}
  </div>
</footer>
