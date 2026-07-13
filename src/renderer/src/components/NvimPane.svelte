<script lang="ts">
  // Embedded Neovim editor: a canvas-rendered ext_linegrid UI bound to a
  // vendored `nvim --embed` sidecar in main. The session/canvas/input plumbing
  // lives in NvimCanvasSession; this component adds the editor-specific chrome
  // (buffer tabs, minimap) and effects (tab follow, reveal, theme, keymap sync).
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import BufferTabs from './BufferTabs.svelte'
  import Minimap from './Minimap.svelte'
  import { settings } from '../lib/settings.svelte'
  import { NvimCanvasSession } from '../lib/nvim/session'
  import { registerNvimSession, unregisterNvimSession } from '../lib/nvim/registry'
  import { nvimKeymapBindings, type NvimMapping } from '../lib/nvimKeymap'
  import { operatorHintEntries, operatorTitle } from '../lib/nvimOperatorHints'

  let { leafId }: { leafId: string } = $props()

  let hostEl = $state<HTMLDivElement>()
  let canvasEl = $state<HTMLCanvasElement>()
  // Hidden contenteditable rather than a textarea: it receives keydown and IME
  // composition, but does not trip the keymap's INPUT/TEXTAREA guard, so the
  // space leader still works while nvim is in normal mode.
  let inputEl = $state<HTMLDivElement>()
  let unavailable = $state(false)

  let session: NvimCanvasSession | null = null
  let disposeNvimBindings: (() => void) | null = null
  let lastPushedPath: string | null = null
  // Cached operator-pending maps (plugin text objects); refetched with the
  // normal-mode keymap since it rarely changes mid-session.
  let operatorMaps: NvimMapping[] = []

  // Reactive mirrors for the minimap child: the session id once attached, and a
  // tick bumped on each redraw flush so it re-reads the buffer view.
  let minimapNvimId = $state<string | null>(null)
  let minimapTick = $state(0)

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  function selectTab(path: string): void {
    store.activeTabPath = path
  }

  function closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation()
    store.closeTab(path)
  }

  function cssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  function fontSize(): number {
    const configured = settings.get<number>('workbench.nvimFontSize')
    if (typeof configured === 'number' && configured > 4) return configured
    return 13
  }

  // Surface nvim's own leader maps in grove's which-key. Global + buffer-local
  // normal-mode maps are refetched on attach and on buffer change (plugins and
  // buffers register maps lazily); buffer-local entries win on collision.
  async function syncNvimKeymap(): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      const [bufferMaps, globalMaps, bufferOmaps, globalOmaps] = await Promise.all([
        window.workbench.nvim.request(id, 'nvim_buf_get_keymap', [0, 'n']),
        window.workbench.nvim.request(id, 'nvim_get_keymap', ['n']),
        window.workbench.nvim.request(id, 'nvim_buf_get_keymap', [0, 'o']),
        window.workbench.nvim.request(id, 'nvim_get_keymap', ['o'])
      ])
      if (!session?.id || !Array.isArray(bufferMaps) || !Array.isArray(globalMaps)) return
      const mappings = [...bufferMaps, ...globalMaps] as NvimMapping[]
      const bindings = nvimKeymapBindings(mappings, 'editor', 'normal', (lhs) => {
        if (session?.id) void window.workbench.nvim.input(session.id, lhs)
      })
      disposeNvimBindings?.()
      disposeNvimBindings = keymap.registerBindings(bindings)
      const omaps: NvimMapping[] = []
      if (Array.isArray(bufferOmaps)) omaps.push(...(bufferOmaps as NvimMapping[]))
      if (Array.isArray(globalOmaps)) omaps.push(...(globalOmaps as NvimMapping[]))
      operatorMaps = omaps
    } catch {
      // session gone
    }
  }

  // Surface the operator-pending which-key panel when nvim enters (e.g.) `d`,
  // sourcing the pending operator from v:operator so the title matches. Hidden
  // on any transition back out of operator-pending mode.
  async function handleModeChange(mode: string): Promise<void> {
    if (mode !== 'operator') {
      keymap.hideHints()
      return
    }
    const id = session?.id
    if (!id) return
    let operator = ''
    try {
      const value = await window.workbench.nvim.request(id, 'nvim_get_vvar', ['operator'])
      if (typeof value === 'string') operator = value
    } catch {
      // session gone
    }
    // The operator may have completed while the query was in flight (fast `dw`).
    if (keymap.mode !== 'operator') return
    keymap.showHints(operatorTitle(operator), operatorHintEntries(operator, operatorMaps))
  }

  onMount(() => {
    keymap.setPaneMode(leafId, 'normal')
    if (!hostEl || !canvasEl || !inputEl) return
    const font = { family: cssVar('--font-mono', 'monospace'), sizePx: fontSize() }
    session = new NvimCanvasSession(
      { host: hostEl, canvas: canvasEl, input: inputEl },
      { leafId, font, initialFile: () => store.activeTabPath },
      {
        onAttached: (id) => {
          // Claim the current path so the tab-follow effect doesn't re-edit it;
          // a fresh session (start or restart) already opened it via initialFile.
          lastPushedPath = store.activeTabPath
          minimapNvimId = id
          void syncNvimKeymap()
        },
        onFlush: () => {
          minimapTick += 1
        },
        onModeChange: (mode) => {
          void handleModeChange(mode)
        },
        onExited: (exitCode) => {
          console.warn(`nvim editor pane crashed (code ${exitCode}); restarting`)
          minimapNvimId = null
        },
        onClose: () => {
          minimapNvimId = null
          layout.closeLeaf(leafId)
        },
        onUnavailable: () => {
          unavailable = true
        }
      }
    )
    registerNvimSession(leafId, session)
    void session.start()
  })

  // Spatial pane nav focuses the leaf container; pull focus into the input so
  // keys reach nvim.
  $effect(() => {
    if (keymap.activePane === leafId) session?.focus()
  })

  // Follow grove's active tab into nvim (finder/tree opens).
  $effect(() => {
    const path = store.activeTabPath
    const id = session?.id
    if (!id || !path || path === lastPushedPath) return
    lastPushedPath = path
    void window.workbench.nvim
      .request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      .then(() => syncNvimKeymap())
      .catch(() => {})
  })

  // Jump to a specific line when a search result (ripgrep) is accepted. Claim
  // lastPushedPath so the tab-follow effect doesn't also re-edit the file.
  $effect(() => {
    const target = store.revealTarget
    const id = session?.id
    if (!id || !target) return
    store.revealTarget = null
    lastPushedPath = target.path
    void revealLine(target.path, target.line)
  })

  async function revealLine(path: string, line: number): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      await window.workbench.nvim.request(id, 'nvim_win_set_cursor', [0, [line, 0]])
      // Center the target line and drop to the first non-blank column.
      await window.workbench.nvim.request(id, 'nvim_cmd', [
        { cmd: 'normal', args: ['zz^'], bang: true },
        {}
      ])
    } catch {
      // session gone or file vanished
    }
    session?.focus()
  }

  // Restyle nvim when grove's theme changes.
  $effect(() => {
    void store.activeTheme
    void session?.pushTheme()
  })

  onDestroy(() => {
    disposeNvimBindings?.()
    keymap.hideHints()
    unregisterNvimSession(leafId)
    session?.dispose()
  })
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  <BufferTabs tabs={activeTabs} onSelect={selectTab} onClose={closeTab} />

  <div bind:this={hostEl} class="relative min-h-0 flex-1 overflow-hidden bg-canvas" role="none">
    {#if unavailable}
      <div class="flex h-full items-center justify-center text-dim">
        Neovim runtime missing — run `bun scripts/fetch-nvim.ts` and reopen this pane.
      </div>
    {:else}
      <canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
      {#if minimapNvimId}
        <Minimap
          nvimId={minimapNvimId}
          tick={minimapTick}
          theme={store.activeTheme}
          class="absolute right-0 top-0 z-20 h-full w-[64px] border-l border-line"
        />
      {/if}
      <div
        bind:this={inputEl}
        contenteditable="true"
        class="absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0 outline-none"
        role="textbox"
        tabindex="0"
        aria-label="Neovim input"
      ></div>
    {/if}
  </div>
</div>
