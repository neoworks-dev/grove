<script lang="ts">
  import { settings } from '../lib/settings.svelte'
  import { onDestroy } from 'svelte'
  import Icon from '@iconify/svelte'
  import { store } from '../lib/store.svelte'
  import { languageExtension, editorTheme, baseExtensions } from '../lib/editor'
  import { onHighlightersChanged } from '../lib/highlighters'
  import {
    lspExtensions,
    lspLanguageFor,
    fileUri,
    toCmDiagnostics,
    type LspContext
  } from '../lib/lspClient'
  import type { LspDiagnosticsEvent } from '../../../shared/types'
  import { EditorView } from '@codemirror/view'
  import { EditorState, Compartment, type Extension } from '@codemirror/state'
  import { setDiagnostics } from '@codemirror/lint'
  import { vim, Vim, getCM } from '@replit/codemirror-vim'
  import { keymap } from '../lib/keymap.svelte'

  let editorHost = $state<HTMLDivElement>()
  let view: EditorView | null = null
  let vimEnabled = $state(settings.get<boolean>('workbench.vimMode') ?? true)
  let dirtyPaths = $state<Record<string, boolean>>({})

  // Compartments let us swap language, theme, Vim, and LSP without recreating.
  const languageComp = new Compartment()
  const themeComp = new Compartment()
  const vimComp = new Compartment()
  const lspComp = new Compartment()

  // LSP context for the open file (null when the language has no server).
  let lspCtx: LspContext | null = null
  let docVersion = 1
  let lspChangeTimer: ReturnType<typeof setTimeout> | null = null

  // Guards the dirty flag while we replace the document programmatically.
  let suppressDirty = false

  // Cache of open file contents keyed by absolute path.
  const contentCache = new Map<string, string>()

  // Full editor state per open buffer, keyed by absolute path. Swapping tabs
  // restores the cached state via view.setState() so each buffer keeps its
  // parsed syntax tree, selection, scroll, and undo history in memory — no
  // re-parse or re-highlight on every tab switch. `activeBufferPath` is the
  // buffer whose state is currently live in the view (not yet stashed).
  const bufferStates = new Map<string, EditorState>()
  let activeBufferPath: string | null = null

  // `:w` in Vim saves the active buffer, like the toolbar Save button.
  Vim.defineEx('write', 'w', () => void save())

  function onEditorUpdate(update: { docChanged: boolean }): void {
    if (!update.docChanged) return
    if (!suppressDirty && store.activeTabPath) {
      dirtyPaths = { ...dirtyPaths, [store.activeTabPath]: true }
    }
    if (lspCtx && !suppressDirty) scheduleLspChange()
  }

  // Extensions for a buffer's state. Language is baked per buffer (so its parse
  // tree is retained across swaps); theme/vim/lsp live in compartments that are
  // re-synced to the current global settings after each swap.
  function buildExtensions(path: string): Extension[] {
    const theme = store.activeTheme
    return [
      vimComp.of(vimEnabled ? vim() : []),
      baseExtensions(() => void save()),
      languageComp.of(languageExtension(path)),
      lspComp.of([]),
      themeComp.of(editorTheme(theme.palette, theme.scheme)),
      EditorView.updateListener.of(onEditorUpdate)
    ]
  }

  function ensureEditor(): void {
    if (view || !editorHost) return
    const state = EditorState.create({ doc: '', extensions: buildExtensions('untitled.txt') })
    view = new EditorView({ state, parent: editorHost })
    activeBufferPath = null
    if (vimEnabled) attachVimMode()
  }

  // Stash the live buffer's state so a later swap back restores its parse tree,
  // cursor, scroll, and undo.
  function stashActive(): void {
    if (view && activeBufferPath) bufferStates.set(activeBufferPath, view.state)
  }

  // Re-apply the global theme and Vim setting to the freshly swapped-in state.
  // Neither touches the language compartment, so the parse tree is preserved.
  function syncGlobalCompartments(): void {
    if (!view) return
    const theme = store.activeTheme
    view.dispatch({
      effects: [
        themeComp.reconfigure(editorTheme(theme.palette, theme.scheme)),
        vimComp.reconfigure(vimEnabled ? vim() : [])
      ]
    })
    if (vimEnabled) attachVimMode()
    else keymap.editorVimMode = 'insert'
  }

  // Drop cached states for inactive buffers so they rebuild with current
  // theme/grammar on next open (treesitter colors bake the palette in). The
  // live buffer is refreshed separately via reapplyLanguage.
  function invalidateInactiveBuffers(): void {
    for (const key of [...bufferStates.keys()]) {
      if (key !== activeBufferPath) bufferStates.delete(key)
    }
  }

  // Show an empty buffer (no file open).
  function blankEditor(): void {
    if (!view) return
    stashActive()
    suppressDirty = true
    view.setState(EditorState.create({ doc: '', extensions: buildExtensions('untitled.txt') }))
    suppressDirty = false
    activeBufferPath = null
    syncGlobalCompartments()
  }

  // Publish the Vim mode so the keymap only treats space as leader in normal
  // mode (never while inserting text). Vim off = treat as insert (no leader).
  function attachVimMode(): void {
    if (!view) return
    const cm = getCM(view)
    keymap.editorVimMode = 'normal'
    cm?.on('vim-mode-change', (event: { mode: string }) => {
      keymap.editorVimMode = event.mode
    })
  }

  function toggleVim(): void {
    vimEnabled = !vimEnabled
    void settings.set('workbench.vimMode', vimEnabled, 'user')
    view?.dispatch({ effects: vimComp.reconfigure(vimEnabled ? vim() : []) })
    if (vimEnabled) attachVimMode()
    else keymap.editorVimMode = 'insert'
  }

  async function loadIntoEditor(path: string): Promise<void> {
    ensureEditor()
    if (!view || !store.selectedWorktreeId) return

    let state = bufferStates.get(path)
    if (!state) {
      let content = contentCache.get(path)
      if (content === undefined) {
        content = await window.workbench.files.read(store.selectedWorktreeId, path)
        contentCache.set(path, content)
      }
      // A newer tab switch superseded this load during the async read.
      if (store.activeTabPath !== path || !view) return
      state = EditorState.create({ doc: content, extensions: buildExtensions(path) })
      bufferStates.set(path, state)
    }

    stashActive()
    suppressDirty = true
    view.setState(state)
    suppressDirty = false
    activeBufferPath = path
    syncGlobalCompartments()
    void applyLsp(path, view.state.doc.toString())
    // If we were asked to reveal a line in this file, do it now that it's loaded.
    if (store.revealTarget?.path === path) {
      revealLine(store.revealTarget.line)
      store.revealTarget = null
    }
  }

  // Wire (or clear) the LSP for the open file: reconfigure the compartment and
  // open the document on the server. No-op when the language has no server.
  async function applyLsp(path: string, content: string): Promise<void> {
    if (!view || !store.selectedWorktreeId) return
    const language = lspLanguageFor(path)
    if (!language) {
      lspCtx = null
      view.dispatch({ effects: lspComp.reconfigure([]) })
      return
    }
    const ctx: LspContext = {
      worktreeId: store.selectedWorktreeId,
      path,
      uri: fileUri(path),
      language
    }
    const started = await window.workbench.lsp
      .ensure(ctx.worktreeId, ctx.language, ctx.uri, content)
      .catch(() => false)
    if (!started || store.activeTabPath !== path || !view) {
      lspCtx = null
      view?.dispatch({ effects: lspComp.reconfigure([]) })
      return
    }
    lspCtx = ctx
    docVersion = 1
    view.dispatch({ effects: lspComp.reconfigure(lspExtensions(ctx)) })
  }

  // Debounced full-document sync to the language server.
  function scheduleLspChange(): void {
    if (lspChangeTimer) clearTimeout(lspChangeTimer)
    lspChangeTimer = setTimeout(() => {
      if (!view || !lspCtx) return
      docVersion += 1
      void window.workbench.lsp.didChange(
        lspCtx.worktreeId,
        lspCtx.language,
        lspCtx.uri,
        docVersion,
        view.state.doc.toString()
      )
    }, 300)
  }

  // Move the cursor to a 1-based line and scroll it into view.
  function revealLine(line: number): void {
    if (!view) return
    const total = view.state.doc.lines
    const target = Math.max(1, Math.min(line, total))
    const pos = view.state.doc.line(target).from
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
  }

  async function save(): Promise<void> {
    if (!view || !store.activeTabPath || !store.selectedWorktreeId) return
    const content = view.state.doc.toString()
    await window.workbench.files.write(store.selectedWorktreeId, store.activeTabPath, content)
    contentCache.set(store.activeTabPath, content)
    dirtyPaths = { ...dirtyPaths, [store.activeTabPath]: false }
  }

  function selectTab(path: string): void {
    store.activeTabPath = path
  }

  function closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation()
    contentCache.delete(path)
    bufferStates.delete(path)
    if (activeBufferPath === path) activeBufferPath = null
    store.closeTab(path)
    // If that emptied the tab strip, the load effect blanks the view; when
    // another tab becomes active it drives the swap.
    if (!store.activeTabPath && view) blankEditor()
  }

  // Load whichever tab is active. This is the single load path, so opening a
  // file from the tree, tabs, or another pane (e.g. an agent card) funnels here.
  let loadedPath: string | null = null
  $effect(() => {
    const path = store.activeTabPath
    if (path === loadedPath) return
    loadedPath = path
    if (!path) {
      blankEditor()
      return
    }
    void loadIntoEditor(path)
  })

  // Reveal request for a file that is already open (loadIntoEditor handles the
  // not-yet-loaded case).
  $effect(() => {
    const target = store.revealTarget
    if (target && loadedPath === target.path) {
      revealLine(target.line)
      store.revealTarget = null
    }
  })

  // Reload the open file when it changes on disk (e.g. an agent edit), unless it
  // has unsaved edits — never clobber the user's buffer.
  async function reloadIfExternal(): Promise<void> {
    if (!view || !store.activeTabPath || !store.selectedWorktreeId) return
    const path = store.activeTabPath
    if (dirtyPaths[path]) return
    const content = await window.workbench.files.read(store.selectedWorktreeId, path)
    contentCache.set(path, content)
    if (view.state.doc.toString() === content) return
    const selection = view.state.selection.main
    suppressDirty = true
    const anchor = Math.min(selection.anchor, content.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor }
    })
    suppressDirty = false
    dirtyPaths = { ...dirtyPaths, [path]: false }
  }

  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    store.fsVersion[worktreeId]
    void reloadIfExternal()
  })

  // Re-apply the language grammar for the open file (tree-sitter colors are
  // baked from the palette, so also rebuild on theme change; and when a grammar
  // finishes loading asynchronously).
  function reapplyLanguage(): void {
    if (view && loadedPath) view.dispatch({ effects: languageComp.reconfigure(languageExtension(loadedPath)) })
  }

  // Follow the active color theme (per-instance CM theme, reconfigured live).
  $effect(() => {
    const theme = store.activeTheme
    if (view) {
      view.dispatch({ effects: themeComp.reconfigure(editorTheme(theme.palette, theme.scheme)) })
      reapplyLanguage()
      invalidateInactiveBuffers()
    }
  })

  const stopHighlighterWatch = onHighlightersChanged(() => {
    reapplyLanguage()
    invalidateInactiveBuffers()
  })

  // Apply diagnostics pushed by the language server for the open file.
  const stopLspDiagnostics = window.workbench.on('event:lsp-diagnostics', (payload) => {
    const event = payload as LspDiagnosticsEvent
    if (!view || !lspCtx || event.uri !== lspCtx.uri) return
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, event.diagnostics)))
  })

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  onDestroy(() => {
    stopHighlighterWatch()
    stopLspDiagnostics()
    if (lspChangeTimer) clearTimeout(lspChangeTimer)
    view?.destroy()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 border-b border-line px-2 py-1">
      <div class="nw-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {#each activeTabs as tab (tab.path)}
          <div
            class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs {store.activeTabPath ===
            tab.path
              ? 'bg-surface text-default'
              : 'text-dim hover:text-default'}"
          >
            <button class="flex items-center gap-1" onclick={() => selectTab(tab.path)}>
              {#if tab.pinned}<Icon icon="ph:push-pin-fill" width="11" height="11" class="text-amber" />{/if}
              <span>{tab.name}</span>
              {#if dirtyPaths[tab.path]}<span class="text-amber">●</span>{/if}
            </button>
            <button
              class="text-dim hover:text-red"
              title="Close tab"
              onclick={(event) => closeTab(tab.path, event)}>✕</button
            >
          </div>
        {/each}
      </div>
      <button
        class="rounded-md border border-line px-2 py-1 text-2xs {vimEnabled
          ? 'text-green'
          : 'text-dim'}"
        onclick={toggleVim}
        title="Toggle Vim mode"
      >
        VIM
      </button>
    </div>

  <div bind:this={editorHost} class="min-h-0 flex-1 overflow-hidden"></div>
</div>
