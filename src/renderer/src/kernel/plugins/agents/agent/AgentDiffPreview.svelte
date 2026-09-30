<script lang="ts" module>
  import type { DiffHunk } from '../../../../lib/agents/diff'

  /** One file a call changed, already cut into hunks. */
  export interface FileChange {
    path: string
    hunks: DiffHunk[]
  }
</script>

<script lang="ts">
  // What a call changed, under its row: the changed lines with a little context,
  // cut to a few lines until asked for the rest. The row above already names the
  // file, so a file name only heads its lines when the call changed several.
  import { pathLabelOf } from '../../../../lib/agents/tools'
  import type { DiffLine } from '../../../../lib/agents/diff'

  let { changes, root = '' }: { changes: FileChange[]; root?: string } = $props()

  type PreviewRow =
    | { kind: 'file'; name: string }
    | { kind: 'gap' }
    | { kind: 'line'; line: DiffLine }

  const PREVIEW_ROWS = 8

  let showAll = $state(false)

  /** Every row the preview can show, files and the gaps between hunks included. */
  function rowsOf(list: FileChange[]): PreviewRow[] {
    const rows: PreviewRow[] = []
    for (const change of list) {
      if (list.length > 1) {
        rows.push({ kind: 'file', name: fileNameOf(change.path) })
      }
      change.hunks.forEach((hunk, index) => {
        if (index > 0) {
          rows.push({ kind: 'gap' })
        }
        for (const line of hunk) {
          rows.push({ kind: 'line', line })
        }
      })
    }
    return rows
  }

  /** The path relative to the workspace, or as given when it is outside it. */
  function fileNameOf(path: string): string {
    const label = pathLabelOf(path, root)
    if (label === null) {
      return path
    }
    return label.directory + label.name
  }

  /** What the toggle under a cut preview says. */
  function moreLabel(count: number): string {
    if (count === 1) {
      return 'Show 1 more line'
    }
    return `Show ${count} more lines`
  }

  const rows = $derived(rowsOf(changes))
  const hiddenCount = $derived(Math.max(0, rows.length - PREVIEW_ROWS))
  const shownRows = $derived.by(() => {
    if (showAll) {
      return rows
    }
    return rows.slice(0, PREVIEW_ROWS)
  })
</script>

{#if rows.length > 0}
  <div class="ml-4 mt-1 overflow-hidden rounded border border-line bg-surface font-mono text-2xs">
    {#each shownRows as row, index (index)}
      {#if row.kind === 'file'}
        <div class="truncate border-b border-line-faint px-2 py-0.5 text-dim">{row.name}</div>
      {:else if row.kind === 'gap'}
        <div class="px-2 text-faint" title="Unchanged lines">⋯</div>
      {:else}
        <div
          class="flex"
          class:bg-green-soft={row.line.kind === 'added'}
          class:text-green={row.line.kind === 'added'}
          class:bg-red-soft={row.line.kind === 'removed'}
          class:text-red={row.line.kind === 'removed'}
          class:text-muted={row.line.kind === 'context'}
        >
          <span class="w-4 shrink-0 select-none text-center opacity-70">
            {#if row.line.kind === 'added'}+{:else if row.line.kind === 'removed'}−{/if}
          </span>
          <span class="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">{row.line.text || ' '}</span>
        </div>
      {/if}
    {/each}
    {#if hiddenCount > 0}
      <button
        class="w-full border-t border-line-faint px-2 py-0.5 text-left font-sans text-dim transition-colors duration-100 hover:bg-hover hover:text-default"
        onclick={() => (showAll = !showAll)}
      >
        {#if showAll}Show less{:else}{moreLabel(hiddenCount)}{/if}
      </button>
    {/if}
  </div>
{/if}
