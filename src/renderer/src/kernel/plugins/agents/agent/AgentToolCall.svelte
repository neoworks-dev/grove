<script lang="ts">
  // One tool call: a collapsed header line that expands to its input and result.
  //
  // How a call renders is data, not code — a tool ships a `display` descriptor with
  // each tool (GET /v1/tools), and a tool this pane has never heard of gets the
  // same treatment as a builtin.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import { diffLines, statsOf } from '../../../../lib/agents/diff'
  import {
    editsOf,
    inputViewOf,
    labelFor,
    languageOfInput,
    resultViewOf,
    stringOf,
    asRecord
  } from '../../../../lib/agents/tools'
  import type { ToolItem, ToolStatus } from '../../../../lib/agents/transcript'
  import type { ToolDisplay } from '../../../../lib/agents/types'

  let {
    item,
    display,
    expanded,
    onToggle,
    onOpenFile
  }: {
    item: ToolItem
    display: ToolDisplay | undefined
    expanded: boolean
    onToggle: () => void
    onOpenFile: (path: string) => void
  } = $props()

  // The user may have rewritten the arguments before approving; what ran is what
  // matters.
  const input = $derived(item.editedInput ?? item.input)
  const label = $derived(labelFor(display, input))
  const inputView = $derived(inputViewOf(display))
  const resultView = $derived(resultViewOf(display))
  const language = $derived(languageOfInput(display, input))

  const path = $derived.by<string | null>(() => {
    const fields = asRecord(input)
    if (!fields || typeof fields.path !== 'string') return null
    return fields.path
  })

  const edits = $derived(inputView === 'diff' ? editsOf(input) : [])
  const diffStats = $derived.by(() => {
    let added = 0
    let removed = 0
    for (const edit of edits) {
      const stats = statsOf(diffLines(edit.oldText, edit.newText))
      added += stats.added
      removed += stats.removed
    }
    return { added, removed }
  })

  const resultLines = $derived(item.result.length === 0 ? [] : item.result.split('\n'))

  /** The one field a `code` or `command` view is about. */
  function contentOf(view: 'code' | 'command'): string {
    const record = asRecord(input)
    if (record === null) return ''
    if (view === 'command') return stringOf(record.command)
    return stringOf(record.content)
  }

  const STATUS_COLOR: Record<ToolStatus, string> = {
    pending: 'text-amber',
    running: 'text-blue',
    ok: 'text-dim',
    error: 'text-red',
    denied: 'text-red'
  }
</script>

<div class="mb-1">
  <div class="flex items-center gap-2">
    <button
      class="flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-2xs"
      onclick={onToggle}
      title="Expand the call"
    >
      <span
        class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
        class:rotate-90={expanded}
      >
        <CaretRight width="10" height="10" weight="bold" />
      </span>
      <span class="shrink-0 font-semibold {STATUS_COLOR[item.status]}">{item.name}</span>
      {#if label}<span class="truncate text-muted">{label}</span>{/if}
      {#if diffStats.added > 0}<span class="shrink-0 text-green">+{diffStats.added}</span>{/if}
      {#if diffStats.removed > 0}<span class="shrink-0 text-red">−{diffStats.removed}</span>{/if}
    </button>
    {#if path}
      <button class="shrink-0 text-2xs text-dim hover:text-default" onclick={() => onOpenFile(path)}
        >open ↗</button
      >
    {/if}
  </div>

  {#if item.progress && item.status === 'running'}
    <div class="pl-4 font-mono text-2xs text-dim">{item.progress}</div>
  {/if}

  {#if expanded}
    <!-- Input, rendered the way the tool asked for. -->
    {#if inputView === 'diff'}
      <div class="mt-1 overflow-hidden rounded border border-line pl-0">
        {#each edits as edit, editIndex (editIndex)}
          {#each diffLines(edit.oldText, edit.newText) as line, lineIndex (lineIndex)}
            <div
              class="whitespace-pre-wrap px-2 font-mono text-2xs {line.kind === 'added'
                ? 'bg-green-soft text-green'
                : line.kind === 'removed'
                  ? 'bg-red-soft text-red'
                  : 'text-muted'}"
            >
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
              {line.text}
            </div>
          {/each}
        {/each}
      </div>
    {:else if inputView === 'code' || inputView === 'command'}
      <pre
        class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted"
        data-language={language}>{contentOf(inputView)}</pre>
    {:else if inputView === 'json'}
      <pre
        class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap py-1 pl-4 font-mono text-2xs text-muted">{JSON.stringify(
          input,
          null,
          2
        )}</pre>
    {/if}

    <!-- Result. `hidden` means the tool considers it noise. -->
    {#if resultView !== 'hidden' && item.result.length > 0}
      {#if resultView === 'list'}
        <ul class="mt-1 pl-4">
          {#each resultLines as line, index (index)}
            <li class="truncate font-mono text-2xs text-dim">{line}</li>
          {/each}
        </ul>
      {:else}
        <pre
          class="mb-1 mt-1 max-h-60 overflow-auto whitespace-pre-wrap py-1 pl-4 font-mono text-2xs {item.status ===
          'error'
            ? 'text-red'
            : 'text-dim'}">{item.result}</pre>
      {/if}
    {/if}
  {/if}
</div>
