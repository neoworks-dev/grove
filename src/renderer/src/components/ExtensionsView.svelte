<script lang="ts">
  import { onMount } from 'svelte'
  import { store, applyColorTheme } from '../lib/store.svelte'
  import { loadInstalledExtensions } from '../lib/extensions'
  import { pluginHost } from '../plugins/host.svelte'
  import { layout } from '../lib/layout.svelte'
  import type { CatalogEntry, InstalledExtension } from '../../../shared/types'

  let catalog = $state<CatalogEntry[]>([])
  let installed = $state<Record<string, InstalledExtension>>({})
  let query = $state('')
  let busy = $state<Record<string, boolean>>({})

  // ── Plugins (sandboxed, worker-based) ─────────────────────────
  const plugins = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pluginHost.plugins
    return pluginHost.plugins.filter((record) =>
      `${record.manifest.name} ${record.id} ${record.manifest.description || ''}`
        .toLowerCase()
        .includes(q)
    )
  })

  const statusColor: Record<string, string> = {
    ready: 'text-green',
    disabled: 'text-dim',
    blocked: 'text-amber',
    invalid: 'text-red'
  }

  async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    busy = { ...busy, [pluginId]: true }
    try {
      await window.workbench.plugins.setEnabled(pluginId, enabled)
    } finally {
      busy = { ...busy, [pluginId]: false }
    }
  }

  async function trustPlugin(pluginId: string): Promise<void> {
    busy = { ...busy, [pluginId]: true }
    try {
      await window.workbench.plugins.trust(pluginId)
    } finally {
      busy = { ...busy, [pluginId]: false }
    }
  }

  async function refresh(): Promise<void> {
    catalog = await window.workbench.extensions.catalog().catch(() => [])
    const list = await window.workbench.extensions.installed().catch(() => [])
    installed = Object.fromEntries(list.map((entry) => [entry.id, entry]))
  }

  onMount(refresh)

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((entry) =>
      `${entry.name} ${entry.id} ${entry.kind} ${entry.description || ''}`.toLowerCase().includes(q)
    )
  })

  const kindColor: Record<string, string> = {
    grammar: 'text-violet',
    theme: 'text-amber',
    lsp: 'text-blue'
  }

  async function install(entry: CatalogEntry): Promise<void> {
    busy = { ...busy, [entry.id]: true }
    try {
      await window.workbench.extensions.install(entry.id)
      await loadInstalledExtensions()
      await refresh()
    } catch (err) {
      store.setError(`Install failed: ${(err as Error).message}`)
    } finally {
      busy = { ...busy, [entry.id]: false }
    }
  }

  async function uninstall(entry: CatalogEntry): Promise<void> {
    busy = { ...busy, [entry.id]: true }
    try {
      await window.workbench.extensions.uninstall(entry.id)
      await refresh()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = { ...busy, [entry.id]: false }
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-1 border-b border-line px-2 py-1.5">
    <input
      bind:value={query}
      class="w-full bg-transparent text-xs outline-none placeholder:text-dim"
      placeholder="Search extensions… (grammars, themes, LSP)"
    />
  </div>

  <div class="min-h-0 flex-1 overflow-auto py-1">
    {#if plugins.length > 0}
      <p class="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-caps text-dim">Plugins</p>
      {#each plugins as record (record.id)}
        <div class="border-b border-line/60 px-3 py-2">
          <div class="flex items-center gap-2">
            <span class="truncate text-xs font-medium text-default">{record.manifest.name}</span>
            <span class="shrink-0 text-2xs text-faint">v{record.manifest.version}</span>
            <span class="shrink-0 text-2xs text-faint">{record.source}</span>
            <span class="ml-auto shrink-0 text-2xs {statusColor[record.status]}">{record.status}</span>
          </div>
          {#if record.manifest.description}
            <p class="mt-0.5 text-2xs text-dim">{record.manifest.description}</p>
          {/if}
          {#if (record.manifest.permissions ?? []).length > 0}
            <p class="mt-0.5 font-mono text-2xs text-muted">
              permissions: {(record.manifest.permissions ?? []).join(', ')}
            </p>
          {/if}
          {#if record.errors.length > 0}
            <p class="mt-0.5 font-mono text-2xs text-red">{record.errors.join('; ')}</p>
          {/if}
          <div class="mt-1.5 flex items-center gap-2">
            {#if record.status === 'blocked'}
              <button
                class="rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg disabled:opacity-40"
                disabled={busy[record.id]}
                onclick={() => trustPlugin(record.id)}
              >
                Trust and enable
              </button>
            {:else if record.status === 'ready'}
              <button
                class="rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover disabled:opacity-40"
                disabled={busy[record.id]}
                onclick={() => setPluginEnabled(record.id, false)}
              >
                Disable
              </button>
            {:else if record.status === 'disabled'}
              <button
                class="rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover disabled:opacity-40"
                disabled={busy[record.id]}
                onclick={() => setPluginEnabled(record.id, true)}
              >
                Enable
              </button>
            {/if}
            <button
              class="rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover"
              onclick={() => layout.ensurePane('permissions')}
            >
              Permissions…
            </button>
          </div>
        </div>
      {/each}
      <p class="px-3 pb-1 pt-3 text-2xs font-semibold uppercase tracking-caps text-dim">
        Grammars · Themes · LSP
      </p>
    {/if}
    {#each filtered as entry (entry.id)}
      {@const isInstalled = !!installed[entry.id]}
      <div class="border-b border-line/60 px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="truncate text-xs font-medium text-default">{entry.name}</span>
          <span class="shrink-0 text-2xs uppercase tracking-caps {kindColor[entry.kind] || 'text-dim'}"
            >{entry.kind}</span
          >
          {#if isInstalled}<span class="ml-auto shrink-0 text-2xs text-green">installed</span>{/if}
        </div>
        {#if entry.description}
          <p class="mt-0.5 text-2xs text-dim">{entry.description}</p>
        {/if}
        {#if entry.kind === 'lsp' && entry.lsp?.install}
          <p class="mt-0.5 font-mono text-2xs text-muted">{entry.lsp.install}</p>
        {/if}

        <div class="mt-1.5 flex items-center gap-2">
          {#if !isInstalled}
            <button
              class="rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg disabled:opacity-40"
              disabled={busy[entry.id]}
              onclick={() => install(entry)}
            >
              {busy[entry.id] ? 'Installing…' : 'Install'}
            </button>
          {:else}
            {#if entry.kind === 'theme'}
              <button
                class="rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover"
                onclick={() => applyColorTheme(entry.id)}
              >
                Apply
              </button>
            {/if}
            <button
              class="rounded-md border border-line px-2 py-0.5 text-2xs text-red hover:bg-hover disabled:opacity-40"
              disabled={busy[entry.id]}
              onclick={() => uninstall(entry)}
            >
              Uninstall
            </button>
          {/if}
        </div>
      </div>
    {/each}
    {#if filtered.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No matching extensions.</p>
    {/if}
  </div>
</div>
