<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import groveLogo from './assets/grove-icon.svg'
  import ActivityBar from './components/ActivityBar.svelte'
  import Dock from './components/Dock.svelte'
  import PanelResizer from './components/PanelResizer.svelte'
  import SplitTree from './components/SplitTree.svelte'
  import MenuBar from './components/MenuBar.svelte'
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
    // and the leader beat Neovim's own handlers.
    if (keymap.handleKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Shift+H / Shift+L: previous / next editor tab, but only in Vim-normal so
    // insert typing is never hijacked. K and J are left to Vim (K = hover/type
    // info, J = join), so they are deliberately not mapped here.
    // The nvim editor reports its keymap context as 'editor' (shared with the
    // diff pane), so match the focused leaf's actual pane type instead.
    if (
      layout.focusedLeaf()?.paneTypeId === 'nvim' &&
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
    diagnostics.start()
    registerBaseSettings()
    subscribeEvents()
    registerCoreCommands()
    registerCoreBindings()
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

<div class="flex h-screen w-screen flex-col gap-2 overflow-hidden bg-canvas p-2 text-default">
  <!-- Top bar -->
  <header
    class="flex h-9 shrink-0 items-center gap-3 rounded-xl border border-line-faint bg-surface px-3 text-sm"
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
        class="ml-2 rounded-md px-2 py-1 text-2xs {layout.docks.right.open
          ? 'text-default'
          : 'text-dim hover:text-default'}"
        title="Toggle right panel"
        onclick={() => layout.toggleDock('right')}
      >
        ▤
      </button>
      <button
        class="rounded-md px-2 py-1 text-2xs {layout.focusMode
          ? 'text-default'
          : 'text-dim hover:text-default'}"
        title="Focus mode"
        onclick={() => layout.toggleFocusMode()}
      >
        ⛶
      </button>
      <button
        class="rounded-md border border-line px-2 py-1 text-2xs text-dim hover:text-default"
        title="Command palette (F1)"
        onclick={() => commands.open()}
      >
        ⌘ F1
      </button>
    </div>
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
