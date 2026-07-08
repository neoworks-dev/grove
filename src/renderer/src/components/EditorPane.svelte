<script lang="ts">
  import { onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import FileTree from './FileTree.svelte'
  import { setupMonaco } from '../lib/monaco'
  import { initVimMode } from 'monaco-vim'
  import UIPane from './UIPane.svelte'
  import type { FileNode } from '../../../shared/types'
  import type * as Monaco from 'monaco-editor'

  let treeWidth = $state(Number(localStorage.getItem('pane.editorTree')) || 224)
  $effect(() => localStorage.setItem('pane.editorTree', String(treeWidth)))

  let editorHost = $state<HTMLDivElement>()
  let statusHost = $state<HTMLDivElement>()
  let editor: Monaco.editor.IStandaloneCodeEditor | null = null
  let vimMode: { dispose: () => void } | null = null
  let monaco: typeof Monaco | null = null
  let vimEnabled = $state(true)
  let dirtyPaths = $state<Record<string, boolean>>({})

  // Cache of open file contents keyed by absolute path.
  const contentCache = new Map<string, string>()

  function languageFor(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
      svelte: 'html', yml: 'yaml', yaml: 'yaml', py: 'python', rs: 'rust',
      go: 'go', sh: 'shell', toml: 'ini'
    }
    return map[ext] || 'plaintext'
  }

  function ensureEditor(): void {
    if (editor || !editorHost) return
    monaco = setupMonaco()
    editor = monaco.editor.create(editorHost, {
      value: '',
      language: 'plaintext',
      theme: store.monacoTheme,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Geist Mono, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    editor.onDidChangeModelContent(() => {
      if (store.activeTabPath) {
        dirtyPaths = { ...dirtyPaths, [store.activeTabPath]: true }
      }
    })
    // Ctrl/Cmd+S saves.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
    if (vimEnabled) enableVim()
  }

  function enableVim(): void {
    if (!editor || !statusHost || vimMode) return
    vimMode = initVimMode(editor, statusHost)
  }

  function disableVim(): void {
    vimMode?.dispose()
    vimMode = null
  }

  function toggleVim(): void {
    vimEnabled = !vimEnabled
    if (vimEnabled) enableVim()
    else disableVim()
  }

  function openFile(node: FileNode): void {
    if (!store.selectedWorktreeId) return
    // Opening only sets the active tab; the effect below loads it into Monaco.
    store.openTab({ worktreeId: store.selectedWorktreeId, path: node.path, name: node.name })
  }

  async function loadIntoEditor(path: string): Promise<void> {
    ensureEditor()
    if (!editor || !monaco || !store.selectedWorktreeId) return
    let content = contentCache.get(path)
    if (content === undefined) {
      content = await window.workbench.files.read(store.selectedWorktreeId, path)
      contentCache.set(path, content)
    }
    const model = monaco.editor.createModel(content, languageFor(path))
    const old = editor.getModel()
    editor.setModel(model)
    old?.dispose()
    store.activeTabPath = path
  }

  async function save(): Promise<void> {
    if (!editor || !store.activeTabPath || !store.selectedWorktreeId) return
    const content = editor.getValue()
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
    if (!store.activeTabPath && editor) editor.setModel(null)
  }

  // Load whichever tab is active into Monaco. This is the single load path, so
  // opening a file from the tree, tabs, or another pane (e.g. an agent card)
  // all funnel through here.
  let loadedPath: string | null = null
  $effect(() => {
    const path = store.activeTabPath
    if (path === loadedPath) return
    loadedPath = path
    if (!path) {
      editor?.setModel(null)
      return
    }
    void loadIntoEditor(path)
  })

  // Reload the open file when it changes on disk (e.g. an agent edit), unless it
  // has unsaved edits — never clobber the user's buffer.
  async function reloadIfExternal(): Promise<void> {
    if (!editor || !store.activeTabPath || !store.selectedWorktreeId) return
    const path = store.activeTabPath
    if (dirtyPaths[path]) return
    const content = await window.workbench.files.read(store.selectedWorktreeId, path)
    contentCache.set(path, content)
    const model = editor.getModel()
    if (model && model.getValue() !== content) {
      const position = editor.getPosition()
      model.setValue(content)
      if (position) editor.setPosition(position)
      dirtyPaths = { ...dirtyPaths, [path]: false }
    }
  }

  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    store.fsVersion[worktreeId]
    void reloadIfExternal()
  })

  // Follow the active color theme (Monaco themes are global — one call suffices).
  $effect(() => {
    if (monaco) monaco.editor.setTheme(store.monacoTheme)
  })

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  onDestroy(() => {
    disableVim()
    editor?.dispose()
  })
</script>

<div class="flex h-full min-h-0">
  <!-- File tree -->
  <UIPane side="right" bind:size={treeWidth} min={140} max={420} class="border-r border-line">
    <div class="flex h-full flex-col">
      <div class="px-3 py-2 text-2xs font-semibold uppercase tracking-caps text-dim">Files</div>
      <div class="min-h-0 flex-1 overflow-auto pb-2">
        {#if store.selectedWorktreeId}
          {#key store.selectedWorktreeId}
            <FileTree worktreeId={store.selectedWorktreeId} onOpen={openFile} />
          {/key}
        {/if}
      </div>
    </div>
  </UIPane>

  <!-- Editor -->
  <div class="flex min-w-0 flex-1 flex-col">
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
        title="Save (Ctrl/Cmd+S)"
      >
        Save
      </button>
    </div>

    <div bind:this={editorHost} class="min-h-0 flex-1"></div>
    <div
      bind:this={statusHost}
      class="h-6 shrink-0 border-t border-line bg-canvas px-2 font-mono text-2xs text-muted"
    ></div>
  </div>
</div>
