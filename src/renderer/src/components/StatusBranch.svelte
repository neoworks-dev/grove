<script lang="ts">
  import GitBranch from 'phosphor-svelte/lib/GitBranch'
  import { store } from '../lib/store.svelte'
</script>

{#if store.repo}
  <span class="flex items-center gap-1 font-mono">
    <GitBranch width="12" height="12" />
    {store.repo.currentBranch}
  </span>
{/if}
