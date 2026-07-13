<script module lang="ts">
  // The Vim key→action map is global to the Vim singleton; map the LSP keys
  // once across all editor instances.
  let vimLspMapped = false
</script>

<script lang="ts">
  import { settings } from '../lib/settings.svelte'
  import { onMount, onDestroy } from 'svelte'
  import Icon from '@iconify/svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import EditorMinimap from './EditorMinimap.svelte'
  import { store } from '../lib/store.svelte'
  import { languageExtension, editorTheme, baseExtensions } from '../lib/editor'
  import { onHighlightersChanged } from '../lib/highlighters'
  import {
    lspExtensions,
    lspLanguageFor,
    fileUri,
    toCmDiagnostics,
    offsetToPosition,
    type LspContext
  } from '../lib/lspClient'
  import { showLocations } from '../lib/lspLocations'
  import { applyEditsToText, workspaceEditToFiles } from '../lib/lspEdits'
  import { hoverTooltipField, setHoverTooltip, hoverTooltipAt } from '../lib/editorHover'
  import { VIM_LSP_KEYS, VIM_OPERATOR_HINTS } from '../lib/editorVimKeys'
  import { overlays } from '../lib/overlays.svelte'
  import { dialogs } from '../lib/dialogs.svelte'
  import type {
    LspDiagnosticsEvent,
    LspDiagnostic,
    LspPosition,
    LspRange
  } from '../../../shared/types'
  import type { Location, WorkspaceEdit, Command, CodeAction } from 'vscode-languageserver-types'
  import { EditorView } from '@codemirror/view'
  import { EditorState, Compartment, type Extension } from '@codemirror/state'
  import { setDiagnostics, forEachDiagnostic } from '@codemirror/lint'
  import { vim, Vim, getCM } from '@replit/codemirror-vim'
  import { keymap } from '../lib/keymap.svelte'

  // The split-tree leaf hosting this editor — the pane id the keymap tracks,
  // used to report this instance's Vim mode.
  let { leafId }: { leafId: string } = $props()

  let editorHost = $state<HTMLDivElement>()
  let view = $state<EditorView | null>(null)
  // CodeMirror's scroll element, handed to the FloatingScrollbar overlay once
  // the view exists. CM virtualizes the DOM but keeps real scroll geometry on
  // this element, so the floating thumbs track it like any scroll container.
  let editorScroller = $state<HTMLElement | null>(null)
  let tabStripEl = $state<HTMLDivElement>()
  let dirtyPaths = $state<Record<string, boolean>>({})

  // Keep the active tab visible when it changes (e.g. opened via finder/tree
  // while the strip is scrolled elsewhere).
  $effect(() => {
    const active = store.activeTabPath
    if (!tabStripEl || !active) return
    for (const el of tabStripEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      if (el.dataset.tab !== active) continue
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      return
    }
  })
  // Tells the minimap to re-extract its runs. Bumped on document edits and on
  // full state swaps (view.setState does not fire the update listener).
  let minimapRevision = $state(0)
  // Bumps happen inside $effects (theme follow) — a plain `minimapRevision++`
  // there would read the state it writes and loop the effect. The shadow
  // counter keeps the state write read-free.
  let minimapRevisionCounter = 0

  function bumpMinimapRevision(): void {
    minimapRevisionCounter += 1
    minimapRevision = minimapRevisionCounter
  }

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
    bumpMinimapRevision()
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
      vimComp.of(vim()),
      baseExtensions(() => void save()),
      languageComp.of(languageExtension(path)),
      lspComp.of([]),
      hoverTooltipField,
      themeComp.of(editorTheme(theme.palette, theme.scheme)),
      EditorView.updateListener.of(onEditorUpdate)
    ]
  }

  function ensureEditor(): void {
    if (view || !editorHost) return
    const state = EditorState.create({ doc: '', extensions: buildExtensions('untitled.txt') })
    view = new EditorView({ state, parent: editorHost })
    editorScroller = view.scrollDOM
    activeBufferPath = null
    attachVimMode()
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
        vimComp.reconfigure(vim())
      ]
    })
    attachVimMode()
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
    bumpMinimapRevision()
    syncGlobalCompartments()
  }

  // Publish the Vim mode so the keymap only treats space as leader in normal
  // mode (never while inserting text) and the statusline indicator follows.
  // Vim off = treat as insert (no leader). Visual submodes get their own names.
  function reportVimMode(event: { mode: string; subMode?: string }): void {
    let mode = event.mode
    if (mode === 'visual' && event.subMode === 'linewise') mode = 'visual-line'
    if (mode === 'visual' && event.subMode === 'blockwise') mode = 'visual-block'
    vimMode = mode
    if (operatorHintsShown) hideOperatorHints()
    keymap.setPaneMode(leafId, mode)
  }

  // Operator-pending which-key (e.g. `d` → delete motions). The Vim adapter
  // owns these keys; we only mirror its keypress stream to drive the hints.
  let vimMode = 'normal'
  let operatorHintsShown = false

  function hideOperatorHints(): void {
    operatorHintsShown = false
    keymap.hideHints()
  }

  function handleVimKeypress(key: string): void {
    if (operatorHintsShown) {
      hideOperatorHints()
      return
    }
    if (vimMode !== 'normal') return
    const hints = VIM_OPERATOR_HINTS[key]
    if (!hints) return
    keymap.showHints(hints.title, hints.entries)
    operatorHintsShown = true
  }

  function attachVimMode(): void {
    if (!view) return
    const cm = getCM(view)
    keymap.setPaneMode(leafId, 'normal')
    cm?.on('vim-mode-change', reportVimMode)
    cm?.on('vim-keypress', handleVimKeypress)
    cm?.on('vim-command-done', hideOperatorHints)
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
    bumpMinimapRevision()
    syncGlobalCompartments()
    void applyLsp(path, view.state.doc.toString())
    // If we were asked to reveal a line in this file, do it now that it's loaded.
    if (store.revealTarget?.path === path) {
      revealLine(store.revealTarget.line)
      store.revealTarget = null
    }
    focusContentSoon(path)
  }

  // Land the cursor in the buffer after an open (finder/explorer/agent flows
  // focus the leaf element, not the CodeMirror content). Deferred past
  // focusLeafSoon's requestAnimationFrame so it wins; only when this pane is
  // (or is about to be) the active one, so background loads never steal focus.
  function focusContentSoon(path: string): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!view || store.activeTabPath !== path) return
        if (keymap.activeLeafId !== leafId) return
        view.focus()
      })
    })
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
    if (view && loadedPath)
      view.dispatch({ effects: languageComp.reconfigure(languageExtension(loadedPath)) })
  }

  // Follow the active color theme (per-instance CM theme, reconfigured live).
  $effect(() => {
    const theme = store.activeTheme
    if (view) {
      view.dispatch({ effects: themeComp.reconfigure(editorTheme(theme.palette, theme.scheme)) })
      reapplyLanguage()
      invalidateInactiveBuffers()
      bumpMinimapRevision()
    }
  })

  const stopHighlighterWatch = onHighlightersChanged(() => {
    reapplyLanguage()
    invalidateInactiveBuffers()
    bumpMinimapRevision()
  })

  // Latest LSP diagnostics for the open file, kept in their native shape so
  // code actions and the line-diagnostics popup can use them.
  let lastDiagnostics: LspDiagnostic[] = []

  // Apply diagnostics pushed by the language server for the open file.
  const stopLspDiagnostics = window.workbench.on('event:lsp-diagnostics', (payload) => {
    const event = payload as LspDiagnosticsEvent
    if (!view || !lspCtx || event.uri !== lspCtx.uri) return
    lastDiagnostics = event.diagnostics
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, event.diagnostics)))
  })

  // ── LSP actions (definition, references, rename, format, …) ─────
  // These are wired to Vim normal-mode keys (gd/gr/gI/gy/gD/K, ]d/[d/]e/[e)
  // and leader bindings (<leader>c a/r/d/f). All no-op without a server.
  function cursorPosition(): LspPosition | null {
    if (!view) return null
    return offsetToPosition(view.state.doc, view.state.selection.main.head)
  }

  async function gotoLocations(
    request: (w: string, l: string, u: string, p: LspPosition) => Promise<Location[]>,
    title: string
  ): Promise<void> {
    if (!lspCtx) return
    const position = cursorPosition()
    if (!position) return
    const ctx = lspCtx
    const locations = await request(ctx.worktreeId, ctx.language, ctx.uri, position).catch(() => [])
    showLocations(ctx.worktreeId, locations, title)
  }

  function gotoDefinition(): Promise<void> {
    return gotoLocations(window.workbench.lsp.definition, 'Definition')
  }
  function gotoReferences(): Promise<void> {
    return gotoLocations(window.workbench.lsp.references, 'References')
  }
  function gotoImplementation(): Promise<void> {
    return gotoLocations(window.workbench.lsp.implementation, 'Implementation')
  }
  function gotoTypeDefinition(): Promise<void> {
    return gotoLocations(window.workbench.lsp.typeDefinition, 'Type definition')
  }
  function gotoDeclaration(): Promise<void> {
    return gotoLocations(window.workbench.lsp.declaration, 'Declaration')
  }

  async function hoverAtCursor(): Promise<void> {
    if (!view || !lspCtx) return
    const pos = view.state.selection.main.head
    const text = await window.workbench.lsp
      .hover(lspCtx.worktreeId, lspCtx.language, lspCtx.uri, offsetToPosition(view.state.doc, pos))
      .catch(() => null)
    if (!text || !view) return
    view.dispatch({ effects: setHoverTooltip.of(hoverTooltipAt(pos, text)) })
  }

  // Jump to the next/previous diagnostic from the cursor, optionally errors only.
  function gotoDiagnostic(direction: 'next' | 'prev', errorsOnly: boolean): void {
    if (!view) return
    const spots: number[] = []
    forEachDiagnostic(view.state, (diagnostic, from) => {
      if (errorsOnly && diagnostic.severity !== 'error') return
      spots.push(from)
    })
    if (spots.length === 0) return
    spots.sort((a, b) => a - b)
    const cursor = view.state.selection.main.head
    let target: number
    if (direction === 'next') {
      target = spots.find((spot) => spot > cursor) ?? spots[0]
    } else {
      const before = spots.filter((spot) => spot < cursor)
      target = before.length > 0 ? before[before.length - 1] : spots[spots.length - 1]
    }
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
    view.focus()
  }

  // Show the diagnostics on the cursor's line as a toast.
  function lineDiagnostics(): void {
    if (!view) return
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1
    const onLine = lastDiagnostics.filter(
      (diagnostic) => line >= diagnostic.range.start.line && line <= diagnostic.range.end.line
    )
    if (onLine.length === 0) {
      dialogs.notify({ level: 'info', message: 'No diagnostics on this line', timeoutMs: 2000 })
      return
    }
    const worst = onLine.some((diagnostic) => diagnostic.severity === 1) ? 'error' : 'warn'
    dialogs.notify({ level: worst, message: onLine.map((d) => d.message).join('\n') })
  }

  function wordAtCursor(): string {
    if (!view) return ''
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const column = head - line.from
    const before = line.text.slice(0, column).match(/[\w$]*$/)?.[0] ?? ''
    const after = line.text.slice(column).match(/^[\w$]*/)?.[0] ?? ''
    return before + after
  }

  function rename(): void {
    if (!view || !lspCtx) return
    const symbol = wordAtCursor()
    const position = cursorPosition()
    if (!position) return
    const ctx = lspCtx
    overlays.show({
      id: 'lsp.rename',
      placeholder: `Rename '${symbol}' to…`,
      initialQuery: symbol,
      onQuery: (query, emit) => {
        const name = query.trim()
        emit(
          [{ id: 'rename', label: name ? `Rename to "${name}"` : 'Enter a new name…', data: name }],
          {
            replace: true
          }
        )
      },
      onAccept: async (picked) => {
        const newName = ((picked[0]?.data as string) ?? '').trim()
        if (!newName || newName === symbol) return
        const edit = await window.workbench.lsp
          .rename(ctx.worktreeId, ctx.language, ctx.uri, position, newName)
          .catch(() => null)
        if (!edit) {
          dialogs.notify({ level: 'warn', message: 'Rename not available here', timeoutMs: 2500 })
          return
        }
        await applyWorkspaceEdit(edit)
      }
    })
  }

  async function format(): Promise<void> {
    if (!view || !lspCtx) return
    const edits = await window.workbench.lsp
      .formatting(lspCtx.worktreeId, lspCtx.language, lspCtx.uri, view.state.tabSize)
      .catch(() => [])
    if (edits.length === 0) return
    const current = view.state.doc.toString()
    const updated = applyEditsToText(current, edits)
    if (updated === current) return
    const cursor = view.state.selection.main.head
    suppressDirty = true
    view.dispatch({
      changes: { from: 0, to: current.length, insert: updated },
      selection: { anchor: Math.min(cursor, updated.length) }
    })
    suppressDirty = false
    dirtyPaths = { ...dirtyPaths, [lspCtx.path]: true }
  }

  function diagnosticsInRange(range: LspRange): LspDiagnostic[] {
    return lastDiagnostics.filter(
      (diagnostic) =>
        diagnostic.range.start.line <= range.end.line &&
        diagnostic.range.end.line >= range.start.line
    )
  }

  function codeAction(): void {
    if (!view || !lspCtx) return
    const selection = view.state.selection.main
    const range: LspRange = {
      start: offsetToPosition(view.state.doc, selection.from),
      end: offsetToPosition(view.state.doc, selection.to)
    }
    const ctx = lspCtx
    void (async () => {
      const actions = await window.workbench.lsp
        .codeAction(ctx.worktreeId, ctx.language, ctx.uri, range, diagnosticsInRange(range))
        .catch(() => [])
      if (actions.length === 0) {
        dialogs.notify({ level: 'info', message: 'No code actions', timeoutMs: 2000 })
        return
      }
      overlays.show({
        id: 'lsp.codeAction',
        placeholder: 'Code action',
        onQuery: (query, emit) => {
          const needle = query.trim().toLowerCase()
          const items = actions
            .map((action, index) => ({
              id: String(index),
              label: actionTitle(action),
              data: index
            }))
            .filter((item) => !needle || item.label.toLowerCase().includes(needle))
          emit(items, { replace: true })
        },
        onAccept: async (picked) => {
          const index = picked[0]?.data as number | undefined
          if (index === undefined) return
          await runCodeAction(ctx, actions[index])
        }
      })
    })()
  }

  function actionTitle(action: Command | CodeAction): string {
    return action.title
  }

  function isCommand(action: Command | CodeAction): action is Command {
    return typeof (action as Command).command === 'string'
  }

  async function runCodeAction(ctx: LspContext, action: Command | CodeAction): Promise<void> {
    if (isCommand(action)) {
      await window.workbench.lsp.executeCommand(
        ctx.worktreeId,
        ctx.language,
        action.command,
        action.arguments ?? []
      )
      return
    }
    let resolved = action
    if (!resolved.edit) {
      resolved = await window.workbench.lsp
        .resolveCodeAction(ctx.worktreeId, ctx.language, action)
        .catch(() => action)
    }
    if (resolved.edit) await applyWorkspaceEdit(resolved.edit)
    if (resolved.command) {
      await window.workbench.lsp.executeCommand(
        ctx.worktreeId,
        ctx.language,
        resolved.command.command,
        resolved.command.arguments ?? []
      )
    }
  }

  // Apply a WorkspaceEdit: the active buffer is edited live; other files are
  // rewritten on disk (their cached buffer states are dropped so they re-read).
  async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
    if (!store.selectedWorktreeId) return
    const worktreeId = store.selectedWorktreeId
    const files = workspaceEditToFiles(edit)
    let changed = 0
    for (const file of files) {
      if (file.path === store.activeTabPath && view) {
        const current = view.state.doc.toString()
        suppressDirty = true
        view.dispatch({
          changes: { from: 0, to: current.length, insert: applyEditsToText(current, file.edits) }
        })
        suppressDirty = false
        dirtyPaths = { ...dirtyPaths, [file.path]: true }
      } else {
        const current = await window.workbench.files.read(worktreeId, file.path).catch(() => null)
        if (current === null) continue
        await window.workbench.files.write(
          worktreeId,
          file.path,
          applyEditsToText(current, file.edits)
        )
        contentCache.delete(file.path)
        bufferStates.delete(file.path)
      }
      changed += 1
    }
    if (changed > 0) {
      dialogs.notify({ level: 'info', message: `Updated ${changed} file(s)`, timeoutMs: 2000 })
    }
  }

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  // Bind the Vim normal-mode LSP keys (gd/gr/gI/gy/gD/K, ]d/[d/]e/[e) through
  // the Vim adapter so they coexist with builtin motions (gg, ]}, …). Actions
  // are (re)defined on mount so they close over the live editor; the key→action
  // map is by name, so it always resolves the latest definition.
  function setupVimLspKeys(): void {
    const handlers: Record<string, () => void> = {
      groveLspDefinition: () => void gotoDefinition(),
      groveLspReferences: () => void gotoReferences(),
      groveLspImplementation: () => void gotoImplementation(),
      groveLspTypeDefinition: () => void gotoTypeDefinition(),
      groveLspDeclaration: () => void gotoDeclaration(),
      groveLspHover: () => void hoverAtCursor(),
      groveLspNextDiag: () => gotoDiagnostic('next', false),
      groveLspPrevDiag: () => gotoDiagnostic('prev', false),
      groveLspNextError: () => gotoDiagnostic('next', true),
      groveLspPrevError: () => gotoDiagnostic('prev', true)
    }
    for (const entry of VIM_LSP_KEYS) {
      Vim.defineAction(entry.action, handlers[entry.action])
    }
    if (vimLspMapped) return
    vimLspMapped = true
    for (const entry of VIM_LSP_KEYS) {
      Vim.mapCommand(entry.keys, 'action', entry.action, {}, { context: 'normal' })
    }
  }

  let disposeLspBindings: (() => void) | null = null

  onMount(() => {
    setupVimLspKeys()
    // Leader LSP bindings go through the keymap so they show in which-key and
    // stay customizable. Active only while an editor pane is focused.
    disposeLspBindings = keymap.registerBindings([
      {
        id: 'lsp.codeAction',
        keys: 'leader c a',
        context: 'editor',
        group: 'LSP',
        description: 'Code action',
        run: () => codeAction()
      },
      {
        id: 'lsp.rename',
        keys: 'leader c r',
        context: 'editor',
        group: 'LSP',
        description: 'Rename symbol',
        run: () => rename()
      },
      {
        id: 'lsp.lineDiagnostics',
        keys: 'leader c d',
        context: 'editor',
        group: 'LSP',
        description: 'Line diagnostics',
        run: () => lineDiagnostics()
      },
      {
        id: 'lsp.format',
        keys: 'leader c f',
        context: 'editor',
        group: 'LSP',
        description: 'Format document',
        run: () => void format()
      }
    ])
  })

  onDestroy(() => {
    stopHighlighterWatch()
    stopLspDiagnostics()
    disposeLspBindings?.()
    if (lspChangeTimer) clearTimeout(lspChangeTimer)
    if (operatorHintsShown) hideOperatorHints()
    view?.destroy()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex h-8 shrink-0 items-stretch">
    <div bind:this={tabStripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
      <div class="flex h-full w-max items-stretch">
        {#each activeTabs as tab (tab.path)}
          <div
            data-tab={tab.path}
            class="group/tab flex h-8 shrink-0 cursor-pointer items-center gap-1 px-3 text-xs {store.activeTabPath ===
            tab.path
              ? 'border-x border-line bg-elevated text-default'
              : 'border-y border-line text-dim hover:bg-hover hover:text-default'}"
          >
            <button
              class="flex cursor-pointer items-center gap-1"
              onclick={() => selectTab(tab.path)}
            >
              {#if tab.pinned}<Icon
                  icon="ph:push-pin-fill"
                  width="11"
                  height="11"
                  class="text-amber"
                />{/if}
              <span>{tab.name}</span>
              {#if dirtyPaths[tab.path]}<span class="text-amber">●</span>{/if}
            </button>
            <button
              class="invisible cursor-pointer text-dim hover:text-red group-hover/tab:visible"
              title="Close tab"
              onclick={(event) => closeTab(tab.path, event)}>✕</button
            >
          </div>
        {/each}
      </div>
    </div>
  </div>

  <div class="cm-hide-native-scrollbars flex min-h-0 flex-1 overflow-hidden">
    <div class="relative min-w-0 flex-1">
      <div bind:this={editorHost} class="h-full w-full"></div>
      {#if editorScroller}
        <FloatingScrollbar attachTo={editorScroller} axis="horizontal" class="absolute inset-0" />
      {/if}
    </div>
    {#if view && editorScroller}
      <EditorMinimap
        {view}
        scroller={editorScroller}
        revision={minimapRevision}
        theme={store.activeTheme}
        class="w-[72px] shrink-0"
      />
    {/if}
  </div>
</div>
