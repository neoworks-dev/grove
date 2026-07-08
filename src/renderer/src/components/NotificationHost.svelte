<script lang="ts">
  // Toast stack (top-right, under the header). Click dismisses early.
  import { dialogs } from '../lib/dialogs.svelte'

  const levelClass: Record<string, string> = {
    info: 'border-line text-muted',
    warn: 'border-line text-amber',
    error: 'border-line text-red'
  }
</script>

{#if dialogs.toasts.length > 0}
  <div class="fixed right-3 top-12 z-overlay flex w-80 flex-col gap-2">
    {#each dialogs.toasts as toast (toast.id)}
      <button
        class="rounded-lg border bg-elevated/95 px-3 py-2 text-left text-xs shadow-overlay backdrop-blur {levelClass[
          toast.level
        ]}"
        onclick={() => dialogs.dismiss(toast.id)}
      >
        {toast.message}
      </button>
    {/each}
  </div>
{/if}
