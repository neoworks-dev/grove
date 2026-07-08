<script lang="ts">
  import { statusBar } from '../lib/statusbar.svelte'

  const left = $derived(statusBar.left)
  const right = $derived(statusBar.right)
</script>

<footer
  class="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-elevated px-3 text-2xs text-dim"
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
