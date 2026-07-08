<script lang="ts">
  import { activity } from '../lib/activity.svelte'
</script>

{#if activity.active}
  {@const View = activity.active.view}
  <View />
{/if}
