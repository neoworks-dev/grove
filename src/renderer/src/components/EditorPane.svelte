<script lang="ts">
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
  import { EditorState, Compartment } from '@codemirror/state'
  import { setDiagnostics } from '@codemirror/lint'
  import { vim, Vim, getCM } from '@replit/codemirror-vim'
  import { keymap } from '../lib/keymap.svelte'

  let editorHost = $state<HTMLDivElement>()
  let view: EditorView | null = null
  let vimEnabled = $state(localStorage.getItem('editor.vim') !== 'off')
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

  // `:w` in Vim saves the active buffer, like the toolbar Save button.
  Vim.defineEx('write', 'w', () => void save())

  function ensureEditor(): void {
    if (view || !editorHost) return
    const theme = store.activeTheme
    const state = EditorState.create({
      doc: '',
      extensions: [
        vimComp.of(vimEnabled ? vim() : []),
        baseExtensions(() => void save()),
        languageComp.of([]),
        lspComp.of([]),
        themeComp.of(editorTheme(theme.palette, theme.scheme)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (!suppressDirty && store.activeTabPath) {
            dirtyPaths = { ...dirtyPaths, [store.activeTabPath]: true }
          }
          if (lspCtx && !suppressDirty) scheduleLspChange()
        })
      ]
    })
    view = new EditorView({ state, parent: editorHost })
    if (vimEnabled) attachVimMode()
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
    localStorage.setItem('editor.vim', vimEnabled ? 'on' : 'off')
    view?.dispatch({ effects: vimComp.reconfigure(vimEnabled ? vim() : []) })
    if (vimEnabled) attachVimMode()
    else keymap.editorVimMode = 'insert'
  }

  // Replace the whole document and switch the language grammar in one dispatch.
  function setDocument(content: string, path: string): void {
    if (!view) return
    suppressDirty = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: 0 },
      effects: languageComp.reconfigure(languageExtension(path))
    })
    suppressDirty = false
  }

  async function loadIntoEditor(path: string): Promise<void> {
    ensureEditor()
    if (!view || !store.selectedWorktreeId) return
    let content = contentCache.get(path)
    if (content === undefined) {
      content = await window.workbench.files.read(store.selectedWorktreeId, path)
      contentCache.set(path, content)
    }
    setDocument(content, path)
    store.activeTabPath = path
    void applyLsp(path, content)
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
    store.closeTab(path)
    if (!store.activeTabPath && view) setDocument('', 'untitled.txt')
  }

  // Load whichever tab is active. This is the single load path, so opening a
  // file from the tree, tabs, or another pane (e.g. an agent card) funnels here.
  let loadedPath: string | null = null
  $effect(() => {
    const path = store.activeTabPath
    if (path === loadedPath) return
    loadedPath = path
    if (!path) {
      if (view) setDocument('', 'untitled.txt')
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
    }
  })

  const stopHighlighterWatch = onHighlightersChanged(reapplyLanguage)

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
