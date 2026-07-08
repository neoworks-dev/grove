<script lang="ts">
  import { onMount } from 'svelte'
  import groveLogo from './assets/grove-icon.svg'
  import WorktreeSidebar from './components/WorktreeSidebar.svelte'
  import FilesView from './components/FilesView.svelte'
  import ExtensionsView from './components/ExtensionsView.svelte'
  import ActivityBar from './components/ActivityBar.svelte'
  import SidebarHost from './components/SidebarHost.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import DiffPane from './components/DiffPane.svelte'
  import PreviewPane from './components/PreviewPane.svelte'
  import Dashboard from './components/Dashboard.svelte'
  import LogsPane from './components/LogsPane.svelte'
  import AgentPane from './components/AgentPane.svelte'
  import UIPane from './components/UIPane.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import RipgrepSearch from './components/RipgrepSearch.svelte'
  import FileFinder from './components/FileFinder.svelte'
  import BufferMenu from './components/BufferMenu.svelte'
  import ThemePicker from './components/ThemePicker.svelte'
  import WhichKey from './components/WhichKey.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import StatusBranch from './components/StatusBranch.svelte'
  import StatusClock from './components/StatusClock.svelte'
  import Folder from 'phosphor-svelte/lib/Folder'
  import GitBranch from 'phosphor-svelte/lib/GitBranch'
  import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece'
  import { store, subscribeEvents, openRepoResult, applyIconPack, switchTab } from './lib/store.svelte'
  import { commands } from './lib/commands.svelte'
  import { keymap, pane } from './lib/keymap.svelte'
  import { layout } from './lib/layout.svelte'
  import { activity } from './lib/activity.svelte'
  import { statusBar } from './lib/statusbar.svelte'
  import { registerCoreBindings } from './lib/bindings'
  import { initBundledGrammars } from './lib/bundledGrammars'
  import { loadInstalledExtensions } from './lib/extensions'
  import { initIcons, availablePacks } from './lib/icons'
  import { initThemes } from './lib/themes'
  import { themePicker } from './lib/themepicker.svelte'
  import type { CenterView } from './lib/store.svelte'

  // Core sidebar views for the activity bar (plugins can register more).
  activity.register({ id: 'files', label: 'Explorer', icon: Folder, view: FilesView, order: 1 })
  activity.register({ id: 'worktrees', label: 'Worktrees', icon: GitBranch, view: WorktreeSidebar, order: 2 })
  activity.register({ id: 'extensions', label: 'Extensions', icon: PuzzlePiece, view: ExtensionsView, order: 3 })

  // Core status bar items (plugins can register more, left or right aligned).
  statusBar.register({ id: 'git.branch', align: 'left', order: 1, component: StatusBranch })
  statusBar.register({ id: 'clock', align: 'right', order: 100, component: StatusClock })

  // Persist layout (pane sizes, panels, center view, open tabs) whenever any of
  // these change; layout.schedule() debounces the write to per-repo state.
  $effect(() => {
    const sizes = Object.values(layout.paneSizes)
    const open = layout.logsOpen
    const view = store.centerView
    const tabs = store.tabs.map((tab) => tab.path).join('|')
    const active = store.activeTabPath
    const sidebarView = activity.activeView
    void [sizes, open, view, tabs, active, sidebarView]
    layout.schedule()
  })

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
        layout.setLogsOpen(!layout.logsOpen)
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
    // A single entry opens the theme picker (live-previews on focus, applies on
    // Enter) rather than one command per theme.
    commands.register({
      id: 'theme.switch',
      title: 'Switch Color Theme',
      group: 'Appearance',
      keywords: 'color theme palette scheme dark light appearance',
      run: () => themePicker.show()
    })
  }

  function onGlobalKey(event: KeyboardEvent): void {
    if (event.key === 'F1') {
      event.preventDefault()
      commands.toggle()
      return
    }
    // Delegate to the keymap core (pane nav, leader). Capture phase so Ctrl+hjkl
    // and the leader beat CodeMirror/Vim's own handlers.
    if (keymap.handleKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Shift+hjkl: editor tab motion, but only in Vim-normal so insert typing
    // (which produces H/J/K/L) is never hijacked.
    if (
      keymap.activePane === 'center' &&
      keymap.editorVimMode === 'normal' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      const move = { H: 'prev', L: 'next', K: 'first', J: 'last' }[event.key] as
        | 'prev'
        | 'next'
        | 'first'
        | 'last'
        | undefined
      if (move) {
        switchTab(move)
        event.preventDefault()
        event.stopPropagation()
      }
    }
  }

  onMount(() => {
    initThemes()
    initIcons()
    subscribeEvents()
    registerCoreCommands()
    registerCoreBindings()
    void initBundledGrammars()
    void loadInstalledExtensions()
    window.addEventListener('keydown', onGlobalKey, true)

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

    return () => window.removeEventListener('keydown', onGlobalKey, true)
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
    <img src={groveLogo} alt="Grove" class="h-6 w-auto" />
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
        class="ml-2 rounded-md px-2.5 py-1 text-xs {layout.logsOpen
          ? 'text-default'
          : 'text-dim'} hover:text-default"
        onclick={() => layout.setLogsOpen(!layout.logsOpen)}
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
    <ActivityBar />
    <UIPane
      side="right"
      bind:size={layout.paneSizes.sidebar}
      min={180}
      max={480}
      class="border-r border-line bg-elevated"
    >
      <div
        use:pane={'sidebar'}
        class="h-full outline-none {keymap.activePane === 'sidebar' ? 'pane-active' : ''}"
      >
        <SidebarHost />
      </div>
    </UIPane>

    <main class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-h-0 flex-1">
        <section
          use:pane={'center'}
          class="relative flex min-w-0 flex-1 flex-col outline-none {keymap.activePane === 'center'
            ? 'pane-active'
            : ''}"
        >
          <WhichKey />
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
          bind:size={layout.paneSizes.agent}
          min={240}
          max={560}
          class="border-l border-line bg-elevated"
        >
          <div
            use:pane={'agent'}
            class="h-full outline-none {keymap.activePane === 'agent' ? 'pane-active' : ''}"
          >
            <AgentPane />
          </div>
        </UIPane>
      </div>

      {#if layout.logsOpen}
        <UIPane
          side="top"
          bind:size={layout.paneSizes.logs}
          min={120}
          max={600}
          class="border-t border-line bg-elevated"
        >
          <div
            use:pane={'logs'}
            class="h-full outline-none {keymap.activePane === 'logs' ? 'pane-active' : ''}"
          >
            <LogsPane />
          </div>
        </UIPane>
      {/if}
    </main>
  </div>

  <StatusBar />
</div>

<CommandPalette />
<RipgrepSearch />
<FileFinder />
<BufferMenu />
<ThemePicker />
