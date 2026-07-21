<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import ActivityBar from './components/ActivityBar.svelte'
  import Dock from './components/Dock.svelte'
  import PanelResizer from './components/PanelResizer.svelte'
  import SplitTree from './components/SplitTree.svelte'
  import TopBar from './components/TopBar.svelte'
  import Overlay from './components/Overlay.svelte'
  import WhichKey from './components/WhichKey.svelte'
  import PaneDragOverlay from './components/PaneDragOverlay.svelte'
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
  import { loadInstalledExtensions } from './lib/extensions'
  import { initIcons, availablePacks } from './lib/icons'
  import { diagnostics } from './lib/diagnostics.svelte'
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
    commands.register({
      id: 'view.toggleRightDock',
      title: 'Toggle Right Panel',
      group: 'View',
      run: () => layout.toggleDock('right')
    })
    commands.register({
      id: 'view.toggleFocusMode',
      title: 'Toggle Focus Mode',
      group: 'View',
      keywords: 'zen distraction free fullscreen center',
      run: () => layout.toggleFocusMode()
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

  // Per-pane font zoom is driven from main (event:pane-zoom) because Chromium
  // eats Ctrl/Cmd +/-/0 as page-zoom accelerators before the renderer keydown.
  function applyPaneZoom(direction: unknown): void {
    if (direction === 'in') layout.adjustFocusedFontScale(1)
    else if (direction === 'out') layout.adjustFocusedFontScale(-1)
    else if (direction === 'reset') layout.resetFocusedFontScale()
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
    // shell), except the toggle chord that hides it again. This holds for the
    // standalone terminal pane and for the bottom panel while its Terminal tab
    // is active (the 'panel' pane then reports 'terminal' mode). The mode check
    // is scoped to 'panel' so nvim's own :terminal mode is unaffected.
    const inPanelTerminal = keymap.activePaneType === 'panel' && keymap.mode === 'terminal'
    if (keymap.activePaneType === 'terminal' || inPanelTerminal) {
      if (event.ctrlKey && event.key === '`' && !event.altKey && !event.metaKey) {
        event.preventDefault()
        layout.togglePane(keymap.activePaneType ?? 'terminal')
      }
      return
    }
    // Delegate to the keymap core (pane nav, leader). Capture phase so Ctrl+hjkl
    // and the leader beat Neovim's own handlers.
    if (keymap.handleKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Alt+H / Alt+L: previous / next editor tab, but only in Vim-normal so
    // insert typing is never hijacked. K and J are left to Vim (K = hover/type
    // info, J = join), so they are deliberately not mapped here.
    // The nvim editor reports its keymap context as 'editor' (shared with the
    // diff pane), so match the focused leaf's actual pane type instead.
    // Match on event.code since Alt composes special characters on some layouts.
    if (
      layout.focusedLeaf()?.paneTypeId === 'nvim' &&
      keymap.mode === 'normal' &&
      event.altKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey
    ) {
      const move = { KeyH: 'prev', KeyL: 'next' }[event.code] as 'prev' | 'next' | undefined
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
    diagnostics.start()
    registerBaseSettings()
    subscribeEvents()
    registerCoreCommands()
    registerCoreBindings()
    void loadInstalledExtensions()
    window.addEventListener('keydown', onGlobalKey, true)
    const stopPaneZoom = window.workbench.on('event:pane-zoom', applyPaneZoom)

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

    return () => {
      window.removeEventListener('keydown', onGlobalKey, true)
      stopPaneZoom()
    }
  })

  // Collapse a side panel's width to zero on enter/leave. Because the node keeps
  // its box during the transition, flexbox reallocates the freed width to the
  // center every frame, so the center's resize animates in sync.
  function collapseWidth(node: HTMLElement, params: { duration?: number } = {}) {
    const width = node.offsetWidth
    return {
      duration: params.duration ?? 200,
      easing: cubicOut,
      css: (t: number) => `width:${t * width}px; min-width:0; overflow:hidden;`
    }
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

<div class="flex h-screen w-screen flex-col gap-1.5 overflow-hidden bg-canvas p-2 text-default">
  <!-- Top bar -->
  <header class="h-7 shrink-0 px-1">
    <TopBar />
  </header>

  {#if store.error}
    <div
      class="flex items-center gap-2 rounded-xl border border-line-faint bg-red-soft px-3 py-1.5 text-xs text-red"
    >
      <span>{store.error}</span>
      <button class="ml-auto text-dim hover:text-default" onclick={() => store.clearError()}
        >✕</button
      >
    </div>
  {/if}

  <!-- Main body: launcher rail + docked side panels + the center split trees.
       Docks stay attached (outside the tree); only the center splits. Every
       visited view stays mounted; only the active one is shown (others
       display:none), so switching views flips visibility instead of remounting.
       Focus mode hides the rail + docks and floats the center. -->
  <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
    {#if !layout.focusMode}
      <div class="flex min-h-0 shrink-0" transition:collapseWidth>
        <!-- Left rail + left dock read as one floating surface panel. -->
        <div class="flex shrink-0 overflow-hidden rounded-xl border border-line-faint bg-surface">
          <ActivityBar />
          {#if layout.docks.left.open}
            <Dock side="left" />
          {/if}
        </div>
        <PanelResizer side="left" enabled={layout.docks.left.open} />
      </div>
    {/if}

    <div
      class="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-line-faint bg-surface"
    >
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

    {#if !layout.focusMode && layout.docks.right.open}
      <div class="flex min-h-0 shrink-0" transition:collapseWidth>
        <PanelResizer side="right" />
        <div class="flex shrink-0 overflow-hidden rounded-xl border border-line-faint bg-surface">
          <Dock side="right" />
        </div>
      </div>
    {/if}
  </div>

  <StatusBar />
  <WhichKey />
</div>

<PaneDragOverlay />
<Overlay />
<DialogHost />
<NotificationHost />
<KeybindCheatsheet />
