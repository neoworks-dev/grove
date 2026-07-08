<script lang="ts">
  import { store, refreshRuntimes } from '../lib/store.svelte'
  import type { ServiceRuntime } from '../../../shared/types'

  const statusColor: Record<string, string> = {
    running: 'bg-green',
    starting: 'bg-amber',
    unhealthy: 'bg-red',
    stopped: 'bg-neutral-600'
  }

  const services = $derived<ServiceRuntime[]>(
    store.selectedWorktreeId ? store.services[store.selectedWorktreeId] || [] : []
  )

  async function withRefresh(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
      if (store.selectedWorktreeId) await refreshRuntimes(store.selectedWorktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  function start(name: string): void {
    if (store.selectedWorktreeId)
      void withRefresh(() => window.workbench.services.start(store.selectedWorktreeId!, name))
  }
  function stop(name: string): void {
    if (store.selectedWorktreeId)
      void withRefresh(() => window.workbench.services.stop(store.selectedWorktreeId!, name))
  }
  function restart(name: string): void {
    if (store.selectedWorktreeId)
      void withRefresh(() => window.workbench.services.restart(store.selectedWorktreeId!, name))
  }
  function startAll(): void {
    if (store.selectedWorktreeId)
      void withRefresh(() => window.workbench.services.startAll(store.selectedWorktreeId!))
  }
  function stopAll(): void {
    if (store.selectedWorktreeId)
      void withRefresh(() => window.workbench.services.stopAll(store.selectedWorktreeId!))
  }

  function openPreview(url: string): void {
    store.centerView = 'preview'
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-line px-3 py-1.5">
    <span class="text-2xs uppercase tracking-caps text-dim">Services</span>
    <div class="ml-auto flex gap-1">
      <button
        class="rounded border border-line px-2 py-0.5 text-2xs hover:bg-hover"
        onclick={startAll}>Start all</button
      >
      <button
        class="rounded border border-line px-2 py-0.5 text-2xs hover:bg-hover"
        onclick={stopAll}>Stop all</button
      >
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if services.length === 0}
      <p class="px-3 py-3 text-xs text-dim">No services configured. Add them to workbench.yaml.</p>
    {/if}
    {#each services as service (service.name)}
      <div class="flex items-center gap-2 border-b border-line/50 px-3 py-2 text-xs">
        <span class="h-2 w-2 shrink-0 rounded-full {statusColor[service.status]}"></span>
        <span class="w-24 shrink-0 truncate font-medium">{service.name}</span>
        <span class="w-16 shrink-0 text-dim">{service.status}</span>
        <span class="w-28 shrink-0 font-mono text-2xs text-dim"
          >:{service.ports[0]}{service.ports.length > 1
            ? `–${service.ports[service.ports.length - 1]}`
            : ''}</span
        >
        {#if service.previewUrl}
          <button
            class="text-blue hover:underline"
            onclick={() => openPreview(service.previewUrl!)}
            title={service.previewUrl}>preview</button
          >
        {/if}
        <div class="ml-auto flex gap-1">
          {#if service.status === 'stopped'}
            <button
              class="rounded bg-action px-2 py-0.5 text-2xs text-action-fg"
              onclick={() => start(service.name)}>Start</button
            >
          {:else}
            <button
              class="rounded border border-line px-2 py-0.5 text-2xs hover:bg-hover"
              onclick={() => restart(service.name)}>Restart</button
            >
            <button
              class="rounded border border-line px-2 py-0.5 text-2xs hover:bg-hover"
              onclick={() => stop(service.name)}>Stop</button
            >
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
