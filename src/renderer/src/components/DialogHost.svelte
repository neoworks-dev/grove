<script lang="ts">
  // Renders the active modal confirm dialog. Escape or a backdrop click
  // resolves with 'cancel'.
  import { dialogs } from '../lib/dialogs.svelte'

  const active = $derived(dialogs.active)

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    dialogs.resolveActive('cancel')
  }

  $effect(() => {
    if (!active) return
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  const buttonClass: Record<string, string> = {
    primary: 'border-accent bg-accent text-accent-content hover:opacity-90',
    danger: 'border-line bg-red-soft text-red hover:opacity-90',
    default: 'border-line bg-surface text-default hover:bg-hover'
  }
</script>

{#if active}
  <div
    class="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) dialogs.resolveActive('cancel')
    }}
  >
    <div
      class="w-[28rem] max-w-[90vw] rounded-lg border border-line bg-elevated p-4 shadow-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={active.title}
    >
      <h2 class="text-sm font-semibold text-default">{active.title}</h2>
      <p class="mt-2 whitespace-pre-wrap text-xs text-muted">{active.body}</p>
      {#if active.detail}
        <pre
          class="mt-2 max-h-40 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs text-muted">{active.detail}</pre>
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        {#each active.actions as action (action.id)}
          <button
            class="rounded-md border px-3 py-1.5 text-xs {buttonClass[action.kind ?? 'default']}"
            onclick={() => dialogs.resolveActive(action.id)}
          >
            {action.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
