<script lang="ts">
  import { onMount } from 'svelte'
  import { store, subscribeEvents, openRepoResult } from './lib/store.svelte'
  import WorktreeSidebar from './components/WorktreeSidebar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import DiffPane from './components/DiffPane.svelte'
  import PreviewPane from './components/PreviewPane.svelte'
  import Dashboard from './components/Dashboard.svelte'
  import LogsPane from './components/LogsPane.svelte'
  import AgentPane from './components/AgentPane.svelte'
  import type { CenterView } from './lib/store.svelte'

  let bottomOpen = $state(true)

  onMount(async () => {
    subscribeEvents()
    const last = await window.workbench.repo.last()
    if (last) {
      try {
        const result = await window.workbench.repo.open(last)
        await openRepoResult(result)
      } catch {
        // stale path — ignore, user can re-pick
      }
    }
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

  const views: { id: CenterView; label: string }[] = [
    { id: 'editor', label: 'Editor' },
    { id: 'diff', label: 'Diff' },
    { id: 'preview', label: 'Preview' },
    { id: 'dashboard', label: 'Dashboard' }
  ]
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
    <aside class="w-64 shrink-0 overflow-y-auto border-r border-line bg-elevated">
      <WorktreeSidebar />
    </aside>

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

        <aside class="w-80 shrink-0 overflow-hidden border-l border-line bg-elevated">
          <AgentPane />
        </aside>
      </div>

      {#if bottomOpen}
        <div class="h-56 shrink-0 border-t border-line bg-elevated">
          <LogsPane />
        </div>
      {/if}
    </main>
  </div>
</div>
