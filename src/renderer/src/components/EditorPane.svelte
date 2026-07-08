<script lang="ts">
  import { onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { languageExtension, editorTheme, baseExtensions } from '../lib/editor'
  import { EditorView } from '@codemirror/view'
  import { EditorState, Compartment } from '@codemirror/state'
  import { vim, Vim, getCM } from '@replit/codemirror-vim'
  import { keymap } from '../lib/keymap.svelte'

  let editorHost = $state<HTMLDivElement>()
  let view: EditorView | null = null
  let vimEnabled = $state(localStorage.getItem('editor.vim') !== 'off')
  let dirtyPaths = $state<Record<string, boolean>>({})

  // Compartments let us swap language, theme, and Vim without recreating the view.
  const languageComp = new Compartment()
  const themeComp = new Compartment()
  const vimComp = new Compartment()

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
        themeComp.of(editorTheme(theme.palette, theme.scheme)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressDirty && store.activeTabPath) {
            dirtyPaths = { ...dirtyPaths, [store.activeTabPath]: true }
          }
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
    // If we were asked to reveal a line in this file, do it now that it's loaded.
    if (store.revealTarget?.path === path) {
      revealLine(store.revealTarget.line)
      store.revealTarget = null
    }
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

  // Follow the active color theme (per-instance CM theme, reconfigured live).
  $effect(() => {
    const theme = store.activeTheme
    if (view) view.dispatch({ effects: themeComp.reconfigure(editorTheme(theme.palette, theme.scheme)) })
  })

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  onDestroy(() => view?.destroy())
</script>

<div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 border-b border-line px-2 py-1">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {#each activeTabs as tab (tab.path)}
          <div
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs {store.activeTabPath ===
            tab.path
              ? 'bg-surface text-default'
              : 'text-dim hover:text-default'}"
          >
            <button class="flex items-center gap-1" onclick={() => selectTab(tab.path)}>
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
      <button
        class="rounded-md bg-action px-2 py-1 text-2xs text-action-fg"
        onclick={save}
        title="Save (Ctrl/Cmd+S or :w)"
      >
        Save
      </button>
    </div>

  <div bind:this={editorHost} class="min-h-0 flex-1 overflow-hidden"></div>
</div>
