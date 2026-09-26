<script lang="ts">
  // App header, VSCode command-center style: the app menu on the left, a
  // centered project pill that opens the file finder, and an agents-panel toggle.
  import { store, openRepoResult } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { commands } from '../lib/commands.svelte'
  import MenuBar from './MenuBar.svelte'

  const projectName = $derived(store.repo?.name ?? 'Open a project…')
  const agentsOpen = $derived(layout.hasPaneType('agent'))

  // The pill routes to the file finder when a repo is open, otherwise it becomes
  // the "open a project" affordance.
  function openCommandCenter(): void {
    if (!store.repo) {
      void pickRepo()
      return
    }
    const finder = commands.commands.find((entry) => entry.id === 'files.find')
    if (finder) void finder.run()
  }

  async function pickRepo(): Promise<void> {
    store.clearError()
    try {
      const result = await window.workbench.repo.pick()
      if (result) await openRepoResult(result)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  function toggleAgents(): void {
    layout.togglePane('agent')
  }
</script>

<div class="grid h-full grid-cols-[1fr_auto_1fr] items-center gap-2">
  <!-- Left: the app menu. -->
  <MenuBar />

  <!-- Center: command-center pill — click opens the file finder. -->
  <button
    class="group flex h-6 w-[min(52vw,520px)] items-center justify-center gap-2 rounded-md border border-line-faint bg-canvas px-3 text-xs text-dim transition hover:border-line hover:bg-hover hover:text-default active:scale-[0.99]"
    title="Search files"
    onclick={openCommandCenter}
  >
    <svg class="shrink-0 opacity-70 transition group-hover:opacity-100" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
    <span class="truncate">{projectName}</span>
  </button>

  <!-- Right: agents-panel toggle. -->
  <div class="flex items-center justify-end gap-1">
    <button
      class="flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-hover {agentsOpen
        ? 'text-default'
        : 'text-dim hover:text-default'}"
      title="Toggle agents panel"
      onclick={toggleAgents}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="8" width="16" height="11" rx="2" />
        <path d="M12 8V4M9 2h6" />
        <path d="M8.5 13h.01M15.5 13h.01" />
      </svg>
    </button>
  </div>
</div>
