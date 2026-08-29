<script lang="ts">
  import { onMount } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import ActivityBar from './kernel/plugins/sidebar/ActivityBar.svelte'
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
  import { store, subscribeEvents, openRepoResult, switchTab } from './lib/store.svelte'
  import { commands } from './lib/commands.svelte'
  import { keymap } from './lib/keymap.svelte'
  import { keyDispatch, KeyPriority, startGlobalKeyDispatch } from './lib/keyDispatch'
  import { layout } from './lib/layout.svelte'
  import { settings } from './lib/settings.svelte'
  import { registerBaseSettings, applyBaseSettings } from './lib/baseSettings'
  import { pluginHost } from './plugins/host.svelte'
  import { loadInstalledExtensions } from './lib/editorCatalog'
  import { initIcons } from './lib/icons'
  import { initThemes } from './lib/themes'
  import { overlays } from './lib/overlays.svelte'

  // Panes, views, menus, keybindings, commands and status bar items are all
  // contributed by the core plugins the kernel mounts (kernel/boot.ts). This
  // component is the chrome they render into.

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

  // Per-pane font zoom is driven from main (event:pane-zoom) because Chromium
  // eats Ctrl/Cmd +/-/0 as page-zoom accelerators before the renderer keydown.
  function applyPaneZoom(direction: unknown): void {
    if (direction === 'in') layout.adjustFocusedFontScale(1)
    else if (direction === 'out') layout.adjustFocusedFontScale(-1)
    else if (direction === 'reset') layout.resetFocusedFontScale()
  }

  /** F1 opens the command palette from any context, including under an overlay. */
  function handleCommandPaletteKey(event: KeyboardEvent): boolean {
    if (event.key !== 'F1') return false
    event.preventDefault()
    commands.toggle()
    return true
  }

  /**
   * While an overlay is open it owns the keyboard (its own ctrl+j/k etc.), so
   * the chain stands down. Deliberately does not stop propagation: the
   * overlay's input still has to receive the keystroke.
   */
  function handleOverlayOwnership(): boolean {
    if (!overlays.active) return false
    return true
  }

  /**
   * The terminal owns every key while focused (so Ctrl+C/L/hjkl reach the
   * shell), except the toggle chord that hides it again. This holds for the
   * standalone terminal pane and for the bottom panel while its Terminal tab is
   * active (the 'panel' pane then reports 'terminal' mode). The mode check is
   * scoped to 'panel' so nvim's own :terminal mode is unaffected.
   *
   * Claims the key without stopping propagation so xterm's own handler still
   * sees it; only the toggle chord is swallowed outright.
   */
  function handleTerminalOwnership(event: KeyboardEvent): boolean {
    const inPanelTerminal = keymap.activePaneType === 'panel' && keymap.mode === 'terminal'
    if (keymap.activePaneType !== 'terminal' && !inPanelTerminal) return false
    if (event.ctrlKey && event.key === '`' && !event.altKey && !event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      layout.togglePane(keymap.activePaneType ?? 'terminal')
    }
    return true
  }

  /** Pane navigation, leader sequences and chords, resolved by the keymap core. */
  function handleBindings(event: KeyboardEvent): boolean {
    if (!keymap.handleKey(event)) return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  /**
   * Alt+H / Alt+L: previous / next editor tab, but only in Vim-normal so insert
   * typing is never hijacked. K and J are left to Vim (K = hover/type info,
   * J = join), so they are deliberately not mapped here.
   *
   * The nvim editor reports its keymap context as 'editor' (shared with the
   * diff pane), so this matches the focused leaf's actual pane type instead.
   * Matches on event.code since Alt composes special characters on some layouts.
   */
  function handleEditorTabSwitch(event: KeyboardEvent): boolean {
    if (layout.focusedLeaf()?.paneTypeId !== 'nvim') return false
    if (keymap.mode !== 'normal') return false
    if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return false
    const move = { KeyH: 'prev', KeyL: 'next' }[event.code] as 'prev' | 'next' | undefined
    if (!move) return false
    switchTab(move)
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  onMount(() => {
    // Theme/icons apply synchronously from localStorage (no flash), then get
    // re-applied from the settings provider once it loads.
    initThemes()
    initIcons()
    registerBaseSettings()
    subscribeEvents()
    void loadInstalledExtensions()
    const stopKeyDispatch = startGlobalKeyDispatch()
    const unsubscribeKeys = [
      keyDispatch.subscribe(KeyPriority.hardKey, handleCommandPaletteKey),
      keyDispatch.subscribe(KeyPriority.overlay, handleOverlayOwnership),
      keyDispatch.subscribe(KeyPriority.terminal, handleTerminalOwnership),
      keyDispatch.subscribe(KeyPriority.bindings, handleBindings),
      keyDispatch.subscribe(KeyPriority.app, handleEditorTabSwitch)
    ]
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
      for (const unsubscribe of unsubscribeKeys) unsubscribe()
      stopKeyDispatch()
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

    <!-- No surface of its own: every pane leaf is its own rounded panel, so the
         gutters between them read as the canvas showing through. -->
    <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
  <!-- Window-anchored fallback: editor panes draw their own over the buffer. -->
  {#if keymap.activePaneType !== 'editor'}
    <WhichKey />
  {/if}
</div>

<PaneDragOverlay />
<Overlay />
<DialogHost />
<NotificationHost />
<KeybindCheatsheet />
