<script lang="ts">
  // App header, VSCode command-center style: the app menu on the left, a
  // centered project pill that opens the file finder, window controls right.
  import { store, openRepoResult } from '../lib/store.svelte'
  import { commands } from '../lib/commands.svelte'
  import MenuBar from './MenuBar.svelte'
  import WindowControls from './WindowControls.svelte'
  // The app icon itself, the same artwork the AppImage and the window carry.
  import groveIcon from '../../../../resources/grove-icon.png'

  const projectName = $derived(store.repo?.name ?? 'Open a project…')

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
</script>

<div class="grid h-full grid-cols-[1fr_auto_1fr] items-center gap-2">
  <!-- Left: the Grove mark and the app menu. -->
  <div class="flex items-center gap-1.5">
    <img class="ml-1 size-[18px] shrink-0 rounded" src={groveIcon} alt="Grove" />
    <MenuBar />
  </div>

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

  <!-- Right: settings and the window controls. -->
  <WindowControls />
</div>
