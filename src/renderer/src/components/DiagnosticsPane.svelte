<script lang="ts">
  // Native GUI diagnostics list, driven by data pushed from the embedded Neovim
  // LSP over RPC (see lib/diagnostics). One collapsible group per file; each
  // diagnostic row leads with its line:col and jumps the editor there.
  //
  // Keyboard navigation drives off `rows`, a flattened view of the visible
  // groups and their children. The markup walks the same list, so the cursor
  // index and what is on screen can never disagree.
  import { tick } from 'svelte'
  import Icon from '@iconify/svelte'
  import { store, openFileAtLine } from '../lib/store.svelte'
  import { keymap, pane } from '../lib/keymap.svelte'
  import { fileIcon } from '../lib/icons'
  import { diagnostics, SEVERITY, type Diagnostic } from '../lib/diagnostics.svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'

  // Severity → color + label. The line:col prefix carries the color, so severity
  // reads without spending a column on a glyph.
  const severityStyle: Record<number, { color: string; label: string }> = {
    [SEVERITY.ERROR]: { color: 'text-red', label: 'Error' },
    [SEVERITY.WARN]: { color: 'text-amber', label: 'Warning' },
    [SEVERITY.INFO]: { color: 'text-blue', label: 'Info' },
    [SEVERITY.HINT]: { color: 'text-dim', label: 'Hint' }
  }

  interface FileGroup {
    path: string
    name: string
    /** Directory shown after the filename, relative to the worktree root. */
    dir: string
    items: Diagnostic[]
    errors: number
    warnings: number
  }

  type Row =
    | { kind: 'file'; group: FileGroup }
    | { kind: 'diagnostic'; group: FileGroup; diagnostic: Diagnostic }

  let collapsed = $state<Record<string, boolean>>({})
  let selectedIndex = $state(0)
  let pendingG = false
  let rootEl = $state<HTMLDivElement>()
  let listViewport = $state<HTMLDivElement>()

  // Group the merged list by file. Within a group the sort is by position rather
  // than the store's severity-first order: rows lead with line:col, so a column
  // of numbers that does not ascend reads as a bug.
  const groups = $derived.by<FileGroup[]>(() => {
    const byPath = new Map<string, FileGroup>()
    for (const diagnostic of diagnostics.all) {
      let group = byPath.get(diagnostic.path)
      if (!group) {
        group = {
          path: diagnostic.path,
          name: fileName(diagnostic.path),
          dir: parentDir(diagnostic.path),
          items: [],
          errors: 0,
          warnings: 0
        }
        byPath.set(diagnostic.path, group)
      }
      group.items.push(diagnostic)
      if (diagnostic.severity === SEVERITY.ERROR) group.errors += 1
      else if (diagnostic.severity === SEVERITY.WARN) group.warnings += 1
    }
    for (const group of byPath.values()) {
      group.items.sort((a, b) => a.lnum - b.lnum || a.col - b.col)
    }
    return [...byPath.values()]
  })

  const rows = $derived.by<Row[]>(() => {
    const flattened: Row[] = []
    for (const group of groups) {
      flattened.push({ kind: 'file', group })
      if (collapsed[group.path]) continue
      for (const diagnostic of group.items) {
        flattened.push({ kind: 'diagnostic', group, diagnostic })
      }
    }
    return flattened
  })

  // Diagnostics come and go on every save, so the cursor has to survive a list
  // that shrinks under it.
  $effect(() => {
    const lastIndex = Math.max(0, rows.length - 1)
    if (selectedIndex > lastIndex) selectedIndex = lastIndex
  })

  const selectedRow = $derived(rows[selectedIndex])

  function fileName(path: string): string {
    return path.split('/').pop() || path
  }

  /** Directory of a diagnostic's file, trimmed to the open worktree. */
  function parentDir(path: string): string {
    const parent = path.slice(0, path.lastIndexOf('/'))
    const root = store.selectedWorktree?.path
    if (root && parent.startsWith(`${root}/`)) return parent.slice(root.length + 1)
    if (root && parent === root) return ''
    return parent
  }

  function iconFor(group: FileGroup): string {
    store.iconPack
    return fileIcon(group.name)
  }

  function rowKey(row: Row): string {
    if (row.kind === 'file') return `file:${row.group.path}`
    const { path, lnum, col, severity, message } = row.diagnostic
    return `${path}:${lnum}:${col}:${severity}:${message}`
  }

  // ── Interactions ───────────────────────────────────────────────
  function toggleGroup(group: FileGroup): void {
    collapsed = { ...collapsed, [group.path]: !collapsed[group.path] }
  }

  function jumpTo(diagnostic: Diagnostic): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    // Diagnostic lines are 0-based; the editor reveal API is 1-based.
    openFileAtLine(worktreeId, diagnostic.path, diagnostic.lnum + 1)
  }

  /** Enter/click on a row: file rows fold, diagnostic rows jump the editor. */
  function activate(index: number): void {
    selectedIndex = index
    rootEl?.focus({ preventScroll: true })
    const row = rows[index]
    if (!row) return
    if (row.kind === 'file') toggleGroup(row.group)
    else jumpTo(row.diagnostic)
  }

  // ── Navigation ─────────────────────────────────────────────────
  function scrollSelectedIntoView(): void {
    void tick().then(() => {
      listViewport?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    })
  }

  function rowHeightPx(): number {
    const row = listViewport?.querySelector('[role="treeitem"]') as HTMLElement | null
    return row?.offsetHeight || 20
  }

  // Half the visible rows — the Vim Ctrl-D/Ctrl-U scroll distance.
  function halfPageRows(): number {
    const viewportHeight = listViewport?.clientHeight || 0
    return Math.max(1, Math.floor(viewportHeight / rowHeightPx() / 2))
  }

  function moveSelection(next: number): void {
    selectedIndex = Math.max(0, Math.min(next, rows.length - 1))
    scrollSelectedIntoView()
  }

  /** h on the list: fold an open group, or jump from a child up to its file row. */
  function collapseOrParent(): void {
    const row = selectedRow
    if (!row) return
    if (row.kind === 'diagnostic') {
      moveSelection(rows.findIndex((candidate) => candidate.group === row.group))
      return
    }
    if (!collapsed[row.group.path]) toggleGroup(row.group)
  }

  /** l on the list: unfold a closed group, else step into it / open the row. */
  function expandOrOpen(): void {
    const row = selectedRow
    if (!row) return
    if (row.kind === 'diagnostic') {
      jumpTo(row.diagnostic)
      return
    }
    if (collapsed[row.group.path]) toggleGroup(row.group)
    else moveSelection(selectedIndex + 1)
  }

  function setAllCollapsed(value: boolean): void {
    const next: Record<string, boolean> = {}
    for (const group of groups) next[group.path] = value
    collapsed = next
    moveSelection(selectedIndex)
  }

  // ── Keyboard (diagnostics pane) ────────────────────────────────
  function onKey(event: KeyboardEvent): void {
    if (!handleKey(event)) return
    pendingG = event.key === 'g' && pendingG
    event.preventDefault()
    // Ctrl chords are consumed here; bare keys stay un-stopped so pane-nav
    // chords still reach global dispatch.
    if (event.ctrlKey) event.stopPropagation()
  }

  // Returns true when the key was consumed. Vim-style: j/k to move, h/l to fold
  // and unfold, gg/G to the ends, Ctrl-D/U by half a page.
  function handleKey(event: KeyboardEvent): boolean {
    const key = event.key
    if (event.ctrlKey && (key === 'd' || key === 'D')) {
      moveSelection(selectedIndex + halfPageRows())
      return true
    }
    if (event.ctrlKey && (key === 'u' || key === 'U')) {
      moveSelection(selectedIndex - halfPageRows())
      return true
    }
    if (event.ctrlKey) return false

    if (key === 'j' || key === 'ArrowDown') {
      moveSelection(selectedIndex + 1)
      return true
    }
    if (key === 'k' || key === 'ArrowUp') {
      moveSelection(selectedIndex - 1)
      return true
    }
    if (key === 'G') {
      moveSelection(rows.length - 1)
      return true
    }
    if (key === 'g') {
      if (pendingG) moveSelection(0)
      pendingG = !pendingG
      return true
    }
    if (key === 'l' || key === 'ArrowRight') {
      expandOrOpen()
      return true
    }
    if (key === 'h' || key === 'ArrowLeft') {
      collapseOrParent()
      return true
    }
    if (key === 'Enter') {
      activate(selectedIndex)
      return true
    }
    if (key === 'z') {
      // zM/zR in one key: fold everything, or unfold everything if already folded.
      setAllCollapsed(!groups.every((group) => collapsed[group.path]))
      return true
    }
    return false
  }

  function rowClass(index: number): string {
    if (index === selectedIndex) return 'bg-hover text-default'
    return 'text-muted'
  }
</script>

<div
  bind:this={rootEl}
  use:pane={{ id: 'diagnostics', modes: ['normal'] }}
  class="flex h-full flex-col outline-none {keymap.activePane === 'diagnostics'
    ? 'pane-active'
    : ''}"
  onkeydown={onKey}
  role="tree"
  tabindex="-1"
>
  <FloatingScrollbar class="min-h-0 flex-1 py-0.5" bind:viewport={listViewport}>
    <div>
      {#each rows as row, index (rowKey(row))}
        {#if row.kind === 'file'}
          <div
            class="flex w-full cursor-pointer select-none items-center gap-1 px-2 py-[2px] text-left text-xs {rowClass(
              index
            )} hover:bg-hover"
            role="treeitem"
            tabindex="-1"
            aria-selected={index === selectedIndex}
            aria-expanded={!collapsed[row.group.path]}
            title={row.group.path}
            onclick={() => activate(index)}
          >
            <span class="w-3 shrink-0 text-center text-2xs text-dim"
              >{collapsed[row.group.path] ? '▸' : '▾'}</span
            >
            <Icon icon={iconFor(row.group)} width="13" height="13" class="shrink-0" />
            <span class="shrink-0 text-default">{row.group.name}</span>
            {#if row.group.dir}
              <span class="min-w-0 truncate text-2xs text-dim">{row.group.dir}</span>
            {/if}
            <span class="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs">
              {#if row.group.errors > 0}<span class="text-red">{row.group.errors}</span>{/if}
              {#if row.group.warnings > 0}<span class="text-amber">{row.group.warnings}</span>{/if}
            </span>
          </div>
        {:else}
          {@const style = severityStyle[row.diagnostic.severity] ?? severityStyle[SEVERITY.HINT]}
          <div
            class="flex w-full cursor-pointer select-none items-center gap-2 py-[2px] pl-6 pr-2 text-left text-xs {rowClass(
              index
            )} hover:bg-hover"
            role="treeitem"
            tabindex="-1"
            aria-selected={index === selectedIndex}
            title="{style.label}: {row.diagnostic.message}"
            onclick={() => activate(index)}
          >
            <span class="shrink-0 font-mono text-2xs tabular-nums {style.color}">
              {row.diagnostic.lnum + 1}:{row.diagnostic.col + 1}
            </span>
            <span class="min-w-0 flex-1 truncate">{row.diagnostic.message}</span>
            {#if row.diagnostic.source}
              <span class="shrink-0 text-2xs text-dim">{row.diagnostic.source}</span>
            {/if}
          </div>
        {/if}
      {/each}

      {#if rows.length === 0}
        <p class="px-3 py-4 text-xs text-dim">No diagnostics.</p>
      {/if}
    </div>
  </FloatingScrollbar>
</div>
