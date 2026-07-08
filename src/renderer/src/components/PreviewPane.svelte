<script lang="ts">
  import { store } from '../lib/store.svelte'
  import type { ServiceRuntime } from '../../../shared/types'

  // Preview URLs for services of the selected worktree that declare a preview.
  const previews = $derived<ServiceRuntime[]>(
    (store.selectedWorktreeId ? store.services[store.selectedWorktreeId] || [] : []).filter(
      (service) => service.previewUrl
    )
  )

  let activeUrl = $state<string | null>(null)

  $effect(() => {
    if (previews.length > 0 && !previews.some((service) => service.previewUrl === activeUrl)) {
      activeUrl = previews[0].previewUrl
    }
  })

  function reload(): void {
    const current = activeUrl
    activeUrl = null
    queueMicrotask(() => (activeUrl = current))
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-1 border-b border-line px-2 py-1">
    {#each previews as service (service.name)}
      <button
        class="rounded px-2 py-0.5 text-xs {activeUrl === service.previewUrl
          ? 'bg-surface text-default'
          : 'text-dim hover:text-default'}"
        onclick={() => (activeUrl = service.previewUrl)}
      >
        {service.name}
        <span class="ml-1 font-mono text-2xs text-dim">:{service.ports[0]}</span>
      </button>
    {/each}
    {#if activeUrl}
      <button class="ml-auto text-dim hover:text-default" title="Reload" onclick={reload}>⟳</button>
      <button
        class="text-blue hover:underline"
        onclick={() => activeUrl && window.workbench.openExternal(activeUrl)}>open ↗</button
      >
    {/if}
  </div>

  <div class="min-h-0 flex-1 bg-white">
    {#if activeUrl}
      {#key activeUrl}
        <!-- svelte-ignore a11y_missing_attribute -->
        <webview src={activeUrl} class="h-full w-full"></webview>
      {/key}
    {:else}
      <div class="flex h-full items-center justify-center text-xs text-dim">
        No preview URLs. Start a service with a preview configured.
      </div>
    {/if}
  </div>
</div>
