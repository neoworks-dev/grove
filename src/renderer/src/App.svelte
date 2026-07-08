<script lang="ts">
  import { onMount } from 'svelte'
  import WorktreeSidebar from './components/WorktreeSidebar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import DiffPane from './components/DiffPane.svelte'
  import PreviewPane from './components/PreviewPane.svelte'
  import Dashboard from './components/Dashboard.svelte'
  import LogsPane from './components/LogsPane.svelte'
  import AgentPane from './components/AgentPane.svelte'
  import UIPane from './components/UIPane.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import { store, subscribeEvents, openRepoResult, applyIconPack, applyColorTheme } from './lib/store.svelte'
  import { commands } from './lib/commands.svelte'
  import { initIcons, availablePacks } from './lib/icons'
  import { initThemes, availableThemes } from './lib/themes'
  import type { CenterView } from './lib/store.svelte'

  let bottomOpen = $state(true)

  // Persisted pane sizes (px).
  function persisted(key: string, fallback: number): number {
    const stored = Number(localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? stored : fallback
  }
  let sidebarWidth = $state(persisted('pane.sidebar', 256))
  let agentWidth = $state(persisted('pane.agent', 320))
  let logsHeight = $state(persisted('pane.logs', 224))

  $effect(() => localStorage.setItem('pane.sidebar', String(sidebarWidth)))
  $effect(() => localStorage.setItem('pane.agent', String(agentWidth)))
  $effect(() => localStorage.setItem('pane.logs', String(logsHeight)))

  const views: { id: CenterView; label: string }[] = [
    { id: 'editor', label: 'Editor' },
    { id: 'diff', label: 'Diff' },
    { id: 'preview', label: 'Preview' },
    { id: 'dashboard', label: 'Dashboard' }
  ]

  // Core commands. Other components contribute their own via commands.register.
  function registerCoreCommands(): void {
    commands.register({
      id: 'repo.open',
      title: 'Open Repository…',
      group: 'Repository',
      run: pickRepo
    })
    for (const view of views) {
      commands.register({
        id: `view.${view.id}`,
        title: `View: ${view.label}`,
        group: 'View',
        run: () => {
          store.centerView = view.id
        }
      })
    }
    commands.register({
      id: 'view.toggleLogs',
      title: 'Toggle Logs Panel',
      group: 'View',
      run: () => {
        bottomOpen = !bottomOpen
      }
    })
    // Icon theme selection — dynamically one command per available pack.
    for (const pack of availablePacks()) {
      commands.register({
        id: `icons.${pack.name}`,
        title: `Icon Theme: ${pack.label}`,
        group: 'Appearance',
        keywords: 'icon theme style',
        run: () => applyIconPack(pack.name)
      })
    }
    // Color theme selection — dynamically one command per registered theme.
    for (const theme of availableThemes()) {
      commands.register({
        id: `theme.${theme.name}`,
        title: `Color Theme: ${theme.label}`,
        group: 'Appearance',
        keywords: 'color theme palette scheme dark light',
        run: () => applyColorTheme(theme.name)
      })
    }
  }

  function onGlobalKey(event: KeyboardEvent): void {
    if (event.key === 'F1') {
      event.preventDefault()
      commands.toggle()
    }
  }

  onMount(() => {
    initThemes()
    initIcons()
    subscribeEvents()
    registerCoreCommands()
    window.addEventListener('keydown', onGlobalKey)

    void (async () => {
      const last = await window.workbench.repo.last()
      if (last) {
        try {
          const result = await window.workbench.repo.open(last)
          await openRepoResult(result)
        } catch {
          // stale path — ignore, user can re-pick
        }
      }
    })()

    return () => window.removeEventListener('keydown', onGlobalKey)
  })

  async function pickRepo(): Promise<void> {
    store.clearError()
    try {
      const result = await window.workbench.repo.pick()
      if (result) await openRepoResult(result)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }
</script>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-default">
  <!-- Top bar -->
  <header
    class="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-elevated px-3 text-sm"
  >
    <span class="font-semibold tracking-tight">Worktree Workbench</span>
    <button
      class="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover"
      onclick={pickRepo}
    >
      {store.repo ? 'Change Repo' : 'Open Repo'}
    </button>
    {#if store.repo}
      <span class="text-muted">{store.repo.name}</span>
      <span class="text-dim">·</span>
      <span class="font-mono text-xs text-dim">{store.repo.currentBranch}</span>
    {/if}

    <div class="ml-auto flex items-center gap-1">
      {#each views as view (view.id)}
        <button
          class="rounded-md px-2.5 py-1 text-xs {store.centerView === view.id
            ? 'bg-surface text-default'
            : 'text-dim hover:text-default'}"
          onclick={() => (store.centerView = view.id)}
        >
          {view.label}
        </button>
      {/each}
      <button
        class="ml-2 rounded-md px-2.5 py-1 text-xs {bottomOpen
          ? 'text-default'
          : 'text-dim'} hover:text-default"
        onclick={() => (bottomOpen = !bottomOpen)}
      >
        Logs
      </button>
      <button
        class="ml-2 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:text-default"
        title="Command palette (F1)"
        onclick={() => commands.open()}
      >
        ⌘ F1
      </button>
    </div>
  </header>

  {#if store.error}
    <div
      class="flex items-center gap-2 border-b border-line bg-red-soft px-3 py-1.5 text-xs text-red"
    >
      <span>{store.error}</span>
      <button class="ml-auto text-dim hover:text-default" onclick={() => store.clearError()}
        >✕</button
      >
    </div>
  {/if}

  <!-- Main body -->
  <div class="flex min-h-0 flex-1">
    <UIPane
      side="right"
      bind:size={sidebarWidth}
      min={180}
      max={480}
      class="border-r border-line bg-elevated"
    >
      <WorktreeSidebar />
    </UIPane>

    <main class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-h-0 flex-1">
        <section class="flex min-w-0 flex-1 flex-col">
          {#if !store.repo}
            <div class="flex flex-1 items-center justify-center text-dim">
              Open a Git repository to begin.
            </div>
          {:else if store.centerView === 'editor'}
            <EditorPane />
          {:else if store.centerView === 'diff'}
            <DiffPane />
          {:else if store.centerView === 'preview'}
            <PreviewPane />
          {:else}
            <Dashboard />
          {/if}
        </section>

        <UIPane
          side="left"
          bind:size={agentWidth}
          min={240}
          max={560}
          class="border-l border-line bg-elevated"
        >
          <AgentPane />
        </UIPane>
      </div>

      {#if bottomOpen}
        <UIPane
          side="top"
          bind:size={logsHeight}
          min={120}
          max={600}
          class="border-t border-line bg-elevated"
        >
          <LogsPane />
        </UIPane>
      {/if}
    </main>
  </div>
</div>

<CommandPalette />
