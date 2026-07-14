<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Icon from '@iconify/svelte'
  import { store } from '../lib/store.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { fileIcon, folderIcon } from '../lib/icons'
  import { diagnostics, SEVERITY } from '../lib/diagnostics.svelte'
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import type { FileNode, DiffFile } from '../../../shared/types'

  let {
    worktreeId,
    onOpen
  }: {
    worktreeId: string
    onOpen: (node: FileNode) => void
  } = $props()

  // Directory children keyed by relPath ('' = root). `loadedDirs` mirrors the
  // keys without being reactive, so the reload effect doesn't self-trigger.
  let nodesCache = $state<Record<string, FileNode[]>>({})
  let expanded = $state<Record<string, boolean>>({})
  const loadedDirs = new Set<string>()

  let selectedIndex = $state(0)

  let rootEl = $state<HTMLDivElement>()
  let treeViewport = $state<HTMLDivElement>()
  let pendingG = false

  type Editing = { mode: 'create-file' | 'create-dir' | 'rename'; parentRel: string; targetRel?: string }
  let editing = $state<Editing | null>(null)
  let editValue = $state('')
  let menu = $state<{ x: number; y: number; node: FileNode | null } | null>(null)

  // ── Loading ────────────────────────────────────────────────────
  async function loadDir(rel: string): Promise<void> {
    try {
      const nodes = await window.workbench.files.listDir(worktreeId, rel)
      loadedDirs.add(rel)
      nodesCache = { ...nodesCache, [rel]: nodes }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function reloadCached(): Promise<void> {
    const keys = new Set<string>([''])
    for (const rel of loadedDirs) keys.add(rel)
    await Promise.all([...keys].map(loadDir))
  }

  let lastWorktree = ''
  $effect(() => {
    const id = worktreeId
    store.fsVersion[id]
    if (id !== lastWorktree) {
      lastWorktree = id
      nodesCache = {}
      expanded = {}
      loadedDirs.clear()
      selectedIndex = 0
      void loadDir('')
    } else {
      void reloadCached()
    }
  })

  // ── Visible rows (flattened tree) ──────────────────────────────
  interface Row {
    node: FileNode
    depth: number
  }
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = []
    const walk = (rel: string, depth: number): void => {
      for (const node of nodesCache[rel] || []) {
        out.push({ node, depth })
        if (node.isDir && expanded[node.relPath]) walk(node.relPath, depth + 1)
      }
    }
    walk('', 0)
    return out
  })

  // Keep the selection in range as the visible list changes.
  $effect(() => {
    if (selectedIndex >= rows.length) selectedIndex = Math.max(0, rows.length - 1)
  })

  const selectedRow = $derived(rows[selectedIndex])

  // ── Reveal (from the search overlays) ──────────────────────────
  // Expand every ancestor directory of a worktree-relative path, then select
  // and scroll its row into view.
  async function reveal(relPath: string): Promise<void> {
    const parts = relPath.split('/')
    let rel = ''
    for (let depth = 0; depth < parts.length - 1; depth++) {
      rel = rel ? `${rel}/${parts[depth]}` : parts[depth]
      if (!loadedDirs.has(rel)) await loadDir(rel)
      expanded = { ...expanded, [rel]: true }
    }
    await tick()
    const index = rows.findIndex((row) => row.node.relPath === relPath)
    if (index < 0) return
    selectedIndex = index
    await tick()
    treeViewport?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  // Reveal the active buffer whenever it changes — buffer switches, overlay
  // opens, tab clicks — by expanding to and selecting its row.
  $effect(() => {
    const active = store.activeTabPath
    if (!active || worktreeId !== store.selectedWorktreeId) return
    // Run untracked: reveal reads and writes `expanded` (via the spread), which
    // would otherwise make this effect depend on state it mutates → an infinite
    // update loop when expanding nested paths.
    untrack(() => {
      const root = store.selectedWorktree?.path || ''
      const rel = active.startsWith(`${root}/`) ? active.slice(root.length + 1) : active
      void reveal(rel)
    })
  })

  function iconFor(node: FileNode): string {
    store.iconPack
    return node.isDir ? folderIcon(node.name, !!expanded[node.relPath]) : fileIcon(node.name)
  }

  // ── Git change status (vs HEAD) per worktree-relative path ─────
  const changeBadge: Record<string, string> = {
    added: 'text-green',
    modified: 'text-amber',
    deleted: 'text-red',
    renamed: 'text-blue',
    untracked: 'text-violet'
  }
  let changedByPath = $state<Record<string, string>>({})
  $effect(() => {
    const id = worktreeId
    store.fsVersion[id]
    void (async () => {
      try {
        const files: DiffFile[] = await window.workbench.git.changedFiles(id)
        const map: Record<string, string> = {}
        // Unstaged/staged duplicates collapse to a single mark per path.
        for (const file of files) map[file.path] = file.changeType
        changedByPath = map
      } catch {
        changedByPath = {}
      }
    })()
  })

  // For each changed file, the deepest ancestor folder currently VISIBLE in the
  // tree (its whole ancestor chain expanded). Collapsing a folder moves the tint
  // up to it, so the change stays findable without every ancestor lighting up.
  const changedDirs = $derived.by(() => {
    const dirs = new Set<string>()
    for (const rel of Object.keys(changedByPath)) {
      const parts = rel.split('/')
      let ancestorsExpanded = true
      let deepestVisible: string | null = null
      let acc = ''
      for (let depth = 0; depth < parts.length - 1; depth++) {
        acc = acc ? `${acc}/${parts[depth]}` : parts[depth]
        if (ancestorsExpanded) deepestVisible = acc
        if (!expanded[acc]) ancestorsExpanded = false
      }
      if (deepestVisible) dirs.add(deepestVisible)
    }
    return dirs
  })

  // Color for a row's name: changed files by change type, folders that directly
  // contain a change get a single "modified" tint.
  function nameColor(node: FileNode): string {
    if (!node.isDir) {
      const change = changedByPath[node.relPath]
      return change ? changeBadge[change] : ''
    }
    return changedDirs.has(node.relPath) ? 'text-amber' : ''
  }

  // ── Diagnostic counts per absolute file path ───────────────────
  const diagByPath = $derived.by(() => {
    const map = new Map<string, { errors: number; warnings: number }>()
    for (const diagnostic of diagnostics.all) {
      let entry = map.get(diagnostic.path)
      if (!entry) {
        entry = { errors: 0, warnings: 0 }
        map.set(diagnostic.path, entry)
      }
      if (diagnostic.severity === SEVERITY.ERROR) entry.errors += 1
      else if (diagnostic.severity === SEVERITY.WARN) entry.warnings += 1
    }
    return map
  })

  function parentOf(rel: string): string {
    return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  }

  // ── Interactions ───────────────────────────────────────────────
  function toggleExpand(node: FileNode): void {
    const open = !expanded[node.relPath]
    expanded = { ...expanded, [node.relPath]: open }
    if (open && !loadedDirs.has(node.relPath)) void loadDir(node.relPath)
  }

  function openOrExpand(node: FileNode): void {
    if (node.isDir) toggleExpand(node)
    else onOpen(node)
  }

  function activate(index: number): void {
    selectedIndex = index
    rootEl?.focus({ preventScroll: true })
    if (rows[index]) openOrExpand(rows[index].node)
  }

  // Where a new entry should be created relative to the current selection.
  function creationParent(): string {
    const row = selectedRow
    if (!row) return ''
    if (row.node.isDir) {
      if (!expanded[row.node.relPath]) toggleExpand(row.node)
      return row.node.relPath
    }
    return parentOf(row.node.relPath)
  }

  function startCreate(mode: 'create-file' | 'create-dir'): void {
    editing = { mode, parentRel: creationParent() }
    editValue = ''
  }

  function startRename(): void {
    if (!selectedRow) return
    editing = { mode: 'rename', parentRel: parentOf(selectedRow.node.relPath), targetRel: selectedRow.node.relPath }
    editValue = selectedRow.node.name
  }

  async function commitEdit(): Promise<void> {
    const current = editing
    const name = editValue.trim()
    editing = null
    if (!current || !name) return
    try {
      if (current.mode === 'rename' && current.targetRel) {
        const to = current.parentRel ? `${current.parentRel}/${name}` : name
        await window.workbench.files.rename(worktreeId, current.targetRel, to)
      } else {
        const rel = current.parentRel ? `${current.parentRel}/${name}` : name
        if (current.mode === 'create-dir') await window.workbench.files.createDir(worktreeId, rel)
        else await window.workbench.files.create(worktreeId, rel)
      }
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function deleteNode(node: FileNode): Promise<void> {
    if (!confirm(`Delete "${node.relPath}"? This cannot be undone.`)) return
    try {
      await window.workbench.files.delete(worktreeId, node.relPath)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  // ── Keyboard (tree pane) ───────────────────────────────────────
  function onKey(event: KeyboardEvent): void {
    if (editing) return

    const key = event.key
    if (key === 'j' || key === 'ArrowDown') {
      selectedIndex = Math.min(selectedIndex + 1, rows.length - 1)
    } else if (key === 'k' || key === 'ArrowUp') {
      selectedIndex = Math.max(selectedIndex - 1, 0)
    } else if (key === 'l' || key === 'ArrowRight' || key === 'Enter') {
      if (selectedRow) openOrExpand(selectedRow.node)
    } else if (key === 'h' || key === 'ArrowLeft') {
      collapseOrParent()
    } else if (key === 'G') {
      selectedIndex = rows.length - 1
    } else if (key === 'g') {
      if (pendingG) selectedIndex = 0
      pendingG = !pendingG
      return
    } else if (key === 'a') {
      startCreate('create-file')
    } else if (key === 'A') {
      startCreate('create-dir')
    } else if (key === 'r') {
      startRename()
    } else if (key === 'd') {
      if (selectedRow) void deleteNode(selectedRow.node)
    } else {
      return
    }
    pendingG = false
    if (key !== 'Enter') event.preventDefault()
  }

  // h on the tree: collapse an open dir, else jump to the parent row.
  function collapseOrParent(): void {
    const row = selectedRow
    if (!row) return
    if (row.node.isDir && expanded[row.node.relPath]) {
      expanded = { ...expanded, [row.node.relPath]: false }
      return
    }
    const parent = parentOf(row.node.relPath)
    if (!parent) return
    const parentIndex = rows.findIndex((candidate) => candidate.node.relPath === parent)
    if (parentIndex >= 0) selectedIndex = parentIndex
  }

  function openMenu(event: MouseEvent, node: FileNode | null): void {
    event.preventDefault()
    if (node) {
      const index = rows.findIndex((row) => row.node.relPath === node.relPath)
      if (index >= 0) selectedIndex = index
    }
    menu = { x: event.clientX, y: event.clientY, node }
  }

  const menuItems = $derived.by<MenuItem[]>(() => {
    if (!menu) return []
    const node = menu.node
    const items: MenuItem[] = [
      { label: 'New File', action: () => startCreate('create-file') },
      { label: 'New Folder', action: () => startCreate('create-dir') }
    ]
    if (node) {
      items.push(
        { divider: true },
        { label: 'Rename', action: () => startRename() },
        { label: 'Delete', action: () => void deleteNode(node), danger: true }
      )
    }
    return items
  })
</script>

<div
  bind:this={rootEl}
  use:pane={'tree'}
  class="flex h-full flex-col outline-none {keymap.activePane === 'tree' ? 'pane-active' : ''}"
  onkeydown={onKey}
  role="tree"
  tabindex="-1"
>
  <FloatingScrollbar
    class="min-h-0 flex-1 py-1"
    bind:viewport={treeViewport}
    oncontextmenu={(event) => openMenu(event, null)}
  >
    <!-- Single content wrapper: keeps the scrollbar's ResizeObserver watching
         one child instead of one per row (hundreds), so mounting the tree on a
         view switch stays cheap and directory expansions re-measure correctly. -->
    <div>
    <!-- Inline create row -->
    {#if editing && editing.mode !== 'rename'}
      <div class="flex items-center gap-1 px-2 py-0.5" style="padding-left: 8px">
        <span class="text-2xs text-dim">{editing.mode === 'create-dir' ? '📁' : '📄'}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="w-full bg-input px-1 text-xs outline-none"
          placeholder={editing.parentRel ? `${editing.parentRel}/…` : 'name…'}
          bind:value={editValue}
          autofocus
          onkeydown={(event) => {
            if (event.key === 'Enter') void commitEdit()
            else if (event.key === 'Escape') editing = null
            event.stopPropagation()
          }}
          onblur={() => (editing = null)}
        />
      </div>
    {/if}

    {#each rows as row, index (row.node.relPath)}
        <div
          class="flex w-full cursor-pointer select-none items-center gap-1 px-2 py-[3px] text-left text-xs {index === selectedIndex
            ? 'bg-hover text-default'
            : store.activeTabPath === row.node.path
              ? 'text-default'
              : 'text-muted'} hover:bg-hover"
          style="padding-left: {row.depth * 12 + 8}px"
          role="treeitem"
          tabindex="-1"
          aria-selected={index === selectedIndex}
          onclick={() => activate(index)}
          oncontextmenu={(event) => {
            event.stopPropagation()
            openMenu(event, row.node)
          }}
        >
          <span class="w-3 shrink-0 text-center text-2xs text-dim">
            {#if row.node.isDir}{expanded[row.node.relPath] ? '▾' : '▸'}{/if}
          </span>
          <Icon icon={iconFor(row.node)} width="16" height="16" class="shrink-0" />
          {#if editing && editing.mode === 'rename' && editing.targetRel === row.node.relPath}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="w-full bg-input px-1 text-xs outline-none"
              bind:value={editValue}
              autofocus
              onkeydown={(event) => {
                if (event.key === 'Enter') void commitEdit()
                else if (event.key === 'Escape') editing = null
                event.stopPropagation()
              }}
              onblur={() => (editing = null)}
            />
          {:else}
            {@const change = changedByPath[row.node.relPath]}
            {@const diag = row.node.isDir ? undefined : diagByPath.get(row.node.path)}
            <span class="min-w-0 flex-1 truncate {nameColor(row.node)}">{row.node.name}</span>
            {#if diag && diag.errors > 0}
              <span class="shrink-0 font-mono text-2xs text-red">{diag.errors}</span>
            {:else if diag && diag.warnings > 0}
              <span class="shrink-0 font-mono text-2xs text-amber">{diag.warnings}</span>
            {/if}
            {#if change && !row.node.isDir}
              <span class="shrink-0 font-mono text-2xs {changeBadge[change]}"
                >{change[0].toUpperCase()}</span
              >
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </FloatingScrollbar>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => (menu = null)} />
{/if}
