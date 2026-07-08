<script lang="ts">
  import { activity } from '../lib/activity.svelte'

  // Read the reactive $state directly (not via the class getter) so the swap is
  // reliably tracked; key on the id to remount when the active view changes.
  const active = $derived(
    activity.views.find((view) => view.id === activity.activeView) ?? activity.views[0] ?? null
  )
</script>

{#if active}
  {#key active.id}
    {@const View = active.view}
    <View />
  {/key}
{/if}
