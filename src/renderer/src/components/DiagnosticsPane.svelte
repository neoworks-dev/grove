<script lang="ts">
  // Native GUI diagnostics list, driven by data pushed from the embedded Neovim
  // LSP over RPC (see lib/diagnostics). Grouped by file; clicking a row opens the
  // file at the offending line.
  import { store, openFileAtLine } from '../lib/store.svelte'
  import { diagnostics, SEVERITY, type Diagnostic } from '../lib/diagnostics.svelte'

  // Severity → glyph + color. Kept as plain text marks to match the sidebar's
  // lightweight rows (no icon component per line).
  const severityMark: Record<number, { glyph: string; color: string; label: string }> = {
    [SEVERITY.ERROR]: { glyph: '●', color: 'text-red', label: 'Error' },
    [SEVERITY.WARN]: { glyph: '▲', color: 'text-amber', label: 'Warning' },
    [SEVERITY.INFO]: { glyph: '■', color: 'text-blue', label: 'Info' },
    [SEVERITY.HINT]: { glyph: '○', color: 'text-dim', label: 'Hint' }
  }

  interface FileGroup {
    path: string
    name: string
    items: Diagnostic[]
  }

  // Group the merged list by file, preserving the store's severity/location sort.
  const groups = $derived.by<FileGroup[]>(() => {
    const byPath = new Map<string, FileGroup>()
    for (const diagnostic of diagnostics.all) {
      let group = byPath.get(diagnostic.path)
      if (!group) {
        group = { path: diagnostic.path, name: fileName(diagnostic.path), items: [] }
        byPath.set(diagnostic.path, group)
      }
      group.items.push(diagnostic)
    }
    return [...byPath.values()]
  })

  const counts = $derived(diagnostics.counts)

  function fileName(path: string): string {
    return path.split('/').pop() || path
  }

  function jumpTo(diagnostic: Diagnostic): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    // Diagnostic lines are 0-based; the editor reveal API is 1-based.
    openFileAtLine(worktreeId, diagnostic.path, diagnostic.lnum + 1)
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-3 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Diagnostics</span>
    <div class="ml-auto flex items-center gap-2 text-2xs">
      <span class="text-red" title="Errors">● {counts.errors}</span>
      <span class="text-amber" title="Warnings">▲ {counts.warnings}</span>
      <span class="text-blue" title="Info">■ {counts.info}</span>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#each groups as group (group.path)}
      <div class="px-3 py-1 text-2xs font-medium text-dim" title={group.path}>
        {group.name}
      </div>
      {#each group.items as diagnostic (diagnostic.path + ':' + diagnostic.lnum + ':' + diagnostic.col + ':' + diagnostic.message)}
        {@const mark = severityMark[diagnostic.severity] ?? severityMark[SEVERITY.HINT]}
        <button
          class="flex w-full items-start gap-2 py-1 pl-3 pr-2 text-left text-xs hover:bg-hover"
          onclick={() => jumpTo(diagnostic)}
        >
          <span class="mt-0.5 w-3 shrink-0 text-center {mark.color}" title={mark.label}
            >{mark.glyph}</span
          >
          <span class="min-w-0 flex-1">
            <span class="line-clamp-2 text-default">{diagnostic.message}</span>
            <span class="text-dim">
              {diagnostic.lnum + 1}:{diagnostic.col + 1}{#if diagnostic.source}
                · {diagnostic.source}{/if}
            </span>
          </span>
        </button>
      {/each}
    {/each}

    {#if groups.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No diagnostics.</p>
    {/if}
  </div>
</div>
