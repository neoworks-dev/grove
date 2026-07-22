<script lang="ts">
  import { onMount } from 'svelte'
  import { PERMISSION_META, type PluginPermission } from '../../../shared/plugins'
  import { store } from '../lib/store.svelte'

  interface GrantSummary {
    clientId: string
    clientName: string
    kind: 'plugin' | 'app'
    source?: string
    declared: PluginPermission[]
    permissions: Partial<Record<PluginPermission, 'granted' | 'denied'>>
    fsScopes: string[]
  }

  let grants = $state<GrantSummary[]>([])
  let query = $state('')
  let busy = $state(false)

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return grants
    return grants.filter((entry) =>
      `${entry.clientName} ${entry.clientId}`.toLowerCase().includes(q)
    )
  })

  const riskColor: Record<string, string> = {
    read: 'text-green',
    write: 'text-amber',
    danger: 'text-red'
  }

  const stateColor: Record<string, string> = {
    granted: 'text-green',
    denied: 'text-red'
  }

  function metaFor(permission: PluginPermission): { label: string; description: string; risk: string } {
    const meta = PERMISSION_META[permission]
    if (meta) return meta
    return { label: permission, description: '', risk: 'write' }
  }

  // Declared scopes first (with their decision state), then stray stored
  // decisions for scopes the client no longer declares.
  function scopeRows(entry: GrantSummary): { permission: PluginPermission; decision: string }[] {
    const rows: { permission: PluginPermission; decision: string }[] = []
    for (const permission of entry.declared) {
      rows.push({ permission, decision: entry.permissions[permission] ?? 'not asked' })
    }
    for (const [permission, decision] of Object.entries(entry.permissions)) {
      if (entry.declared.includes(permission as PluginPermission)) continue
      rows.push({ permission: permission as PluginPermission, decision: decision ?? 'not asked' })
    }
    return rows
  }

  async function refresh(): Promise<void> {
    try {
      grants = await window.workbench.plugins.grants.list()
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function mutate(action: () => Promise<GrantSummary[]>): Promise<void> {
    busy = true
    try {
      grants = await action()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  onMount(refresh)
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-1 border-b border-line px-2 py-1.5">
    <input
      bind:value={query}
      class="w-full bg-transparent text-xs outline-none placeholder:text-dim"
      placeholder="Filter plugins and apps…"
    />
    <button
      class="shrink-0 rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover"
      onclick={refresh}
    >
      Refresh
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto py-1">
    <p class="px-3 pb-2 pt-2 text-2xs text-dim">
      Review what each plugin and paired app may do. Revoking a decision does not block the
      client — it asks again the next time the capability is used; choose "Always deny" in that
      prompt to block it.
    </p>

    {#if filtered.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No plugins or apps with declared permissions.</p>
    {/if}

    {#each filtered as entry (entry.clientId)}
      <div class="mx-2 mb-2 rounded-md border border-line/60 px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="truncate text-xs font-medium text-default">{entry.clientName}</span>
          <span class="shrink-0 rounded bg-hover px-1 text-2xs uppercase tracking-caps text-dim">
            {entry.kind === 'app' ? 'external app' : 'plugin'}
          </span>
          {#if entry.source}
            <span class="shrink-0 text-2xs text-faint">{entry.source}</span>
          {/if}
          <button
            class="ml-auto shrink-0 rounded-md border border-line px-2 py-0.5 text-2xs text-red hover:bg-hover disabled:opacity-40"
            disabled={busy}
            onclick={() => mutate(() => window.workbench.plugins.grants.revokeAll(entry.clientId))}
          >
            {entry.kind === 'app' ? 'Unpair' : 'Revoke all'}
          </button>
        </div>

        {#if entry.source === 'builtin'}
          <p class="mt-1 text-2xs text-faint">
            Built-in plugin: declared capabilities are granted automatically.
          </p>
        {/if}

        {#each scopeRows(entry) as row (row.permission)}
          {@const meta = metaFor(row.permission)}
          <div class="mt-1.5 flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-2xs font-medium {riskColor[meta.risk] || 'text-default'}">
                  {meta.label}
                </span>
                <span class="font-mono text-2xs text-faint">{row.permission}</span>
              </div>
              {#if meta.description}
                <p class="text-2xs text-dim">{meta.description}</p>
              {/if}
            </div>
            <span class="shrink-0 text-2xs {stateColor[row.decision] || 'text-faint'}">
              {row.decision}
            </span>
            {#if row.decision === 'granted' || row.decision === 'denied'}
              <button
                class="shrink-0 rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover disabled:opacity-40"
                disabled={busy}
                onclick={() =>
                  mutate(() =>
                    window.workbench.plugins.grants.revoke(entry.clientId, row.permission)
                  )}
              >
                Revoke
              </button>
            {/if}
          </div>
        {/each}

        {#if entry.fsScopes.length > 0}
          <p class="mt-2 text-2xs font-semibold uppercase tracking-caps text-dim">
            Paths outside the worktree
          </p>
          {#each entry.fsScopes as scope (scope)}
            <div class="mt-1 flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{scope}</span>
              <button
                class="shrink-0 rounded-md border border-line px-2 py-0.5 text-2xs hover:bg-hover disabled:opacity-40"
                disabled={busy}
                onclick={() =>
                  mutate(() => window.workbench.plugins.grants.revokeScope(entry.clientId, scope))}
              >
                Revoke
              </button>
            </div>
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</div>
