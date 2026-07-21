<script lang="ts">
  // App header, VSCode command-center style: back/forward on the left, a
  // centered project pill that opens the file finder, an agents-panel toggle,
  // and an overflow menu (⋯) that flattens the whole app menu into one dropdown.
  import { store, switchTab, openRepoResult } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { commands } from '../lib/commands.svelte'
  import { menu, type MenuItem } from '../lib/menu.svelte'

  let menuOpen = $state(false)

  const projectName = $derived(store.repo?.name ?? 'Open a project…')
  const canNavigate = $derived(store.tabs.length > 1)
  const agentsOpen = $derived(
    layout.docks.right.open && layout.docks.right.paneType === 'agent'
  )

  // Every visible top menu with its items, flattened for the ⋯ dropdown.
  const menuSections = $derived(
    menu.menus
      .map((top) => ({ label: top.label, items: withSeparators(menu.itemsFor(top.id)) }))
      .filter((section) => section.items.length > 0)
  )

  function goBack(): void {
    if (canNavigate) switchTab('prev')
  }

  function goForward(): void {
    if (canNavigate) switchTab('next')
  }

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

  function runMenuItem(item: MenuItem): void {
    menuOpen = false
    menu.run(item)
  }

  // Mark the first item of each new group so a divider can render before it.
  function withSeparators(items: MenuItem[]): { item: MenuItem; separator: boolean }[] {
    return items.map((item, index) => {
      const previous = items[index - 1]
      const separator = index > 0 && (previous.group ?? '') !== (item.group ?? '')
      return { item, separator }
    })
  }

  function onWindowPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null
    if (!target?.closest('[data-app-menu]')) menuOpen = false
  }

  function onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') menuOpen = false
  }

  $effect(() => {
    if (!menuOpen) return
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('keydown', onWindowKeyDown, true)
    }
  })
</script>

<div class="grid h-full grid-cols-[1fr_auto_1fr] items-center gap-2">
  <!-- Left: back / forward through the open editors. -->
  <div class="flex items-center gap-0.5">
    <button
      class="flex h-6 w-6 items-center justify-center rounded-md text-dim transition hover:bg-hover hover:text-default disabled:opacity-30 disabled:hover:bg-transparent"
      title="Back"
      disabled={!canNavigate}
      onclick={goBack}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
    <button
      class="flex h-6 w-6 items-center justify-center rounded-md text-dim transition hover:bg-hover hover:text-default disabled:opacity-30 disabled:hover:bg-transparent"
      title="Forward"
      disabled={!canNavigate}
      onclick={goForward}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
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

  <!-- Right: agents-panel toggle + overflow menu. -->
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

    <div class="relative" data-app-menu>
      <button
        class="flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-hover {menuOpen
          ? 'text-default'
          : 'text-dim hover:text-default'}"
        title="Menu"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>

      {#if menuOpen}
        <div
          class="absolute right-0 top-full z-overlay mt-1 max-h-[70vh] min-w-56 overflow-auto rounded-lg border border-line bg-elevated py-1 shadow-overlay"
        >
          {#each menuSections as section, sectionIndex (section.label)}
            {#if sectionIndex > 0}
              <div class="my-1 border-t border-line"></div>
            {/if}
            <div class="px-3 py-1 text-2xs font-semibold uppercase tracking-caps text-dim">
              {section.label}
            </div>
            {#each section.items as entry (entry.item.id)}
              {#if entry.separator}
                <div class="my-1 border-t border-line"></div>
              {/if}
              <button
                class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-default"
                onclick={() => runMenuItem(entry.item)}
              >
                <span class="flex-1 truncate">{entry.item.label}</span>
                {#if entry.item.accelerator}
                  <span class="font-mono text-2xs text-dim">{entry.item.accelerator}</span>
                {/if}
              </button>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
