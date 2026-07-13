<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import groveLogo from './assets/grove-icon.svg'
  import ActivityBar from './components/ActivityBar.svelte'
  import SplitTree from './components/SplitTree.svelte'
  import MenuBar from './components/MenuBar.svelte'
  import Overlay from './components/Overlay.svelte'
  import WhichKey from './components/WhichKey.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import DialogHost from './components/DialogHost.svelte'
  import NotificationHost from './components/NotificationHost.svelte'
  import KeybindCheatsheet from './components/KeybindCheatsheet.svelte'
  import StatusBranch from './components/StatusBranch.svelte'
  import StatusClock from './components/StatusClock.svelte'
  import StatusMode from './components/StatusMode.svelte'
  import { store, subscribeEvents, openRepoResult, applyIconPack, switchTab } from './lib/store.svelte'
  import { commands } from './lib/commands.svelte'
  import { keymap } from './lib/keymap.svelte'
  import { layout } from './lib/layout.svelte'
  import { statusBar } from './lib/statusbar.svelte'
  import { registerCoreBindings } from './lib/bindings'
  import { registerCorePanes } from './lib/corePanes'
  import { registerCoreViews } from './lib/coreViews'
  import { registerCoreMenu } from './lib/coreMenu'
  import { settings } from './lib/settings.svelte'
  import { registerBaseSettings, applyBaseSettings } from './lib/baseSettings'
  import { pluginHost } from './plugins/host.svelte'
  import { views } from './lib/views.svelte'
  import { menu } from './lib/menu.svelte'
  import { initBundledGrammars } from './lib/bundledGrammars'
  import { loadInstalledExtensions } from './lib/extensions'
  import { initIcons, availablePacks } from './lib/icons'
  import { initThemes } from './lib/themes'
  import { themePicker } from './lib/themepicker.svelte'
  import { overlays } from './lib/overlays.svelte'

  // Core pane types, views, and menu structure. Plugins register theirs
  // through the same registries.
  registerCorePanes()
  registerCoreViews()
  registerCoreMenu()

  // Core status bar items (plugins can register more, left or right aligned).
  statusBar.register({ id: 'mode', align: 'left', order: 0, component: StatusMode })
  statusBar.register({ id: 'git.branch', align: 'left', order: 1, component: StatusBranch })
  statusBar.register({ id: 'clock', align: 'right', order: 100, component: StatusClock })

  // Persist layout (split tree, nested panel sizes, open tabs) whenever any of
  // these change; layout.schedule() debounces the write to per-repo state.
  $effect(() => {
    const tree = layout.tree
    const sizes = Object.values(layout.paneSizes)
    const tabs = store.tabs.map((tab) => tab.path).join('|')
    const active = store.activeTabPath
    void [tree, sizes, tabs, active]
    layout.schedule()
  })

  // Registered views drive the header switcher, palette commands, and the
  // View menu — re-registered reactively as plugins add views. The registry
  // writes are untracked: register() also READS its own $state list, which
  // would otherwise make this effect depend on what it writes and loop.
  $effect(() => {
    const list = views.views
    const dispose = untrack(() => {
      const disposeCommands = commands.registerAll(
        list.map((view) => ({
          id: `view.${view.id}`,
          title: `View: ${view.label}`,
          group: 'View',
          run: () => layout.switchView(view.id)
        }))
      )
      const disposeItems = menu.registerItems(
        list.map((view) => ({
          id: `view.switch.${view.id}`,
          menuId: 'view',
          label: view.label,
          group: '1-views',
          order: view.order,
          run: () => layout.switchView(view.id)
        }))
      )
      return () => {
        disposeCommands()
        disposeItems()
      }
    })
    return dispose
  })

  // Core commands. Other components contribute their own via commands.register.
  function registerCoreCommands(): void {
    commands.register({
      id: 'repo.open',
      title: 'Open Repository…',
      group: 'Repository',
      run: pickRepo
    })
    commands.register({
      id: 'view.toggleLogs',
      title: 'Toggle Logs Panel',
      group: 'View',
      run: () => layout.togglePane('logs')
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
    // The keybind-capture widget owns the keyboard entirely while recording.
    if (keymap.captureMode) return
    if (event.key === 'F1') {
      event.preventDefault()
      commands.toggle()
      return
    }
    // While an overlay is open it owns the keyboard (its own ctrl+j/k etc.);
    // the global capture-phase handlers must stand down.
    if (overlays.active) return
    // The terminal owns every key while focused (so Ctrl+C/L/hjkl reach the
    // shell), except the toggle chord that hides it again.
    if (keymap.activePaneType === 'terminal') {
      if (event.ctrlKey && event.key === '`' && !event.altKey && !event.metaKey) {
        event.preventDefault()
        layout.togglePane('terminal')
      }
      return
    }
    // Delegate to the keymap core (pane nav, leader). Capture phase so Ctrl+hjkl
    // and the leader beat CodeMirror/Vim's own handlers.
    if (keymap.handleKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Shift+H / Shift+L: previous / next editor tab, but only in Vim-normal so
    // insert typing is never hijacked. K and J are left to Vim (K = hover/type
    // info, J = join), so they are deliberately not mapped here.
    if (
      keymap.activePaneType === 'editor' &&
      keymap.mode === 'normal' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      const move = { H: 'prev', L: 'next' }[event.key] as 'prev' | 'next' | undefined
      if (move) {
        switchTab(move)
        event.preventDefault()
        event.stopPropagation()
      }
    }
  }

  onMount(() => {
    // Theme/icons apply synchronously from localStorage (no flash), then get
    // re-applied from the settings provider once it loads.
    initThemes()
    initIcons()
    registerBaseSettings()
    subscribeEvents()
    registerCoreCommands()
    registerCoreBindings()
    void initBundledGrammars()
    void loadInstalledExtensions()
    window.addEventListener('keydown', onGlobalKey, true)

    void (async () => {
      await settings.init()
      await applyBaseSettings()
      await pluginHost.init()
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
    <MenuBar />
    {#if store.repo}
      <span class="text-muted">{store.repo.name}</span>
      <span class="text-dim">·</span>
      <span class="font-mono text-xs text-dim">{store.repo.currentBranch}</span>
    {:else}
      <button
        class="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover"
        onclick={pickRepo}
      >
        Open Repo
      </button>
    {/if}

    <div class="ml-auto flex items-center gap-1">
      {#each views.views as view (view.id)}
        <button
          class="rounded-md px-2.5 py-1 text-xs {layout.activeViewId === view.id
            ? 'bg-surface text-default'
            : 'text-dim hover:text-default'}"
          onclick={() => layout.switchView(view.id)}
        >
          {view.label}
        </button>
      {/each}
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

  <!-- Main body: launcher rail + the split trees. Every visited view stays
       mounted; only the active one is shown (others display:none), so switching
       views flips visibility instead of remounting panes. -->
  <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
    <ActivityBar />
    {#each layout.mountedViewIds as viewId (viewId)}
      <div
        class="flex min-h-0 min-w-0 flex-1 overflow-hidden {viewId === layout.activeViewId
          ? ''
          : 'hidden'}"
      >
        <SplitTree node={layout.trees[viewId]} />
      </div>
    {/each}
  </div>

  <StatusBar />
  <WhichKey />
</div>

<Overlay />
<DialogHost />
<NotificationHost />
<KeybindCheatsheet />
