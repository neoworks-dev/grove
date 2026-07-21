<script lang="ts">
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import { renderMarkdown } from '../../lib/markdown'
  import { toolSummary, type OutputItem } from '../../lib/agentStream'
  import {
    buildTranscriptRows,
    toolNames,
    changedFiles,
    resultsByToolKey,
    rowKey,
    userSegments,
    toolDetail,
    resultLabel,
    FILE_EDIT_TOOLS,
    TASK_TOOLS,
    type RenderTool,
    type TranscriptRow
  } from '../../lib/agent/transcript'

  let {
    items,
    visibleItems,
    highlightedKey,
    expandedTools,
    expandedResults,
    expandedGroups,
    toggleTool,
    toggleResult,
    toggleGroup,
    filePath,
    relativePath,
    openCard,
    openCardDiff,
    openMention,
    viewport = $bindable(),
    onscroll
  }: {
    items: OutputItem[]
    visibleItems: OutputItem[]
    highlightedKey: string | null
    expandedTools: Record<string, boolean>
    expandedResults: Record<string, boolean>
    expandedGroups: Record<string, boolean>
    toggleTool: (key: string) => void
    toggleResult: (key: string) => void
    toggleGroup: (key: string) => void
    filePath: (input: Record<string, unknown>) => string | null
    relativePath: (absPath: string) => string | null
    openCard: (input: Record<string, unknown>) => void
    openCardDiff: (input: Record<string, unknown>) => void
    openMention: (path: string) => void
    viewport?: HTMLDivElement
    onscroll: () => void
  } = $props()

  const rows = $derived(buildTranscriptRows(visibleItems, resultsByToolKey(items)))

  // Group rows into sections, one per user message. Each section owns its user
  // bubble as a sticky header: because the sticky element's containing block is
  // the section box (not the whole transcript), the header pins only while its
  // own turn is on screen and scrolls away with the section — the next section's
  // header then takes over. A leading section (no header) holds any rows before
  // the first user message.
  interface Section {
    key: string
    header: TranscriptRow | null
    body: TranscriptRow[]
  }

  function isUserRow(row: TranscriptRow): boolean {
    return row.kind === 'item' && row.item.kind === 'user'
  }

  const sections = $derived.by<Section[]>(() => {
    const result: Section[] = []
    let current: Section = { key: 'lead', header: null, body: [] }
    for (const row of rows) {
      if (!isUserRow(row)) {
        current.body.push(row)
        continue
      }
      if (current.header || current.body.length > 0) result.push(current)
      current = { key: rowKey(row), header: row, body: [] }
    }
    if (current.header || current.body.length > 0) result.push(current)
    return result
  })
</script>

<!-- One tool call: a plain (card-less) line that expands to its full input and
     nested result. -->
{#snippet toolLine(tool: RenderTool)}
  {@const item = tool.item}
  {@const path = filePath(item.input)}
  {@const relative = path ? relativePath(path) : null}
  {@const summary = relative || toolSummary(item.tool, item.input)}
  <div class="mb-1">
    <div class="flex items-center gap-2">
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-2xs"
        onclick={() => toggleTool(item.key)}
        title="Expand full command"
      >
        <span
          class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
          class:rotate-90={expandedTools[item.key]}
        >
          <CaretRight width="10" height="10" weight="bold" />
        </span>
        <span class="shrink-0 font-semibold text-amber">{item.tool}</span>
        {#if summary}<span class="truncate text-muted">{summary}</span>{/if}
      </button>
      {#if path && FILE_EDIT_TOOLS.has(item.tool)}
        <button
          class="shrink-0 text-2xs text-dim hover:text-default"
          title="Show side-by-side diff"
          onclick={() => openCardDiff(item.input)}>diff</button
        >
      {/if}
      {#if path}
        <button
          class="shrink-0 text-2xs text-dim hover:text-default"
          onclick={() => openCard(item.input)}>open ↗</button
        >
      {/if}
    </div>
    {#if expandedTools[item.key]}
      <pre
        class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap py-1 pl-4 font-mono text-2xs text-muted">{toolDetail(
          item.input
        )}</pre>
      {#if tool.result}
        {@const result = tool.result}
        <button
          class="mt-1 flex w-full items-center gap-2 pl-4 text-left font-mono text-2xs {result.isError
            ? 'text-red'
            : 'text-dim'}"
          onclick={() => toggleResult(result.key)}
        >
          <span class="shrink-0">{expandedResults[result.key] ? '▾' : '▸'}</span>
          <span class="truncate">{resultLabel(result.text, result.isError)}</span>
        </button>
        {#if expandedResults[result.key]}
          <pre
            class="mb-1 mt-1 max-h-60 overflow-auto whitespace-pre-wrap py-1 pl-4 font-mono text-2xs text-dim">{result.text}</pre>
        {/if}
      {/if}
    {/if}
  </div>
{/snippet}

<!-- One transcript row: a tool line, a collapsed edit group, or a message. -->
{#snippet renderRow(row: TranscriptRow)}
  {#if row.kind === 'tool'}
        <div
          data-item-key={row.tool.item.key}
          class={row.tool.item.key === highlightedKey ? 'rounded ring-1 ring-amber' : ''}
        >
          {@render toolLine(row.tool)}
        </div>
      {:else if row.kind === 'edit-group'}
        {@const names = toolNames(row.tools)}
        {@const files = changedFiles(row.tools, filePath, relativePath)}
        <div
          data-item-key={row.key}
          class={row.key === highlightedKey ? 'rounded ring-1 ring-amber' : ''}
        >
          <div class="mb-1">
            <button
              class="flex w-full items-center gap-2 text-left font-mono text-2xs"
              onclick={() => toggleGroup(row.key)}
            >
              <span
                class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
                class:rotate-90={expandedGroups[row.key]}
              >
                <CaretRight width="10" height="10" weight="bold" />
              </span>
              <span class="min-w-0 truncate font-semibold text-amber">{names.join(' · ')}</span>
            </button>
            {#if files.length > 0}
              <!-- File badges: relative path with approximate +/- line counts. -->
              <div class="ml-4 mt-1 flex flex-wrap gap-1.5">
                {#each files as file (file.path)}
                  <button
                    class="flex items-center gap-1.5 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-2xs hover:bg-hover"
                    title="Show side-by-side diff"
                    onclick={() => openCardDiff(file.input)}
                  >
                    <span class="min-w-0 truncate text-muted">{file.label}</span>
                    {#if file.added > 0}<span class="text-green">+{file.added}</span>{/if}
                    {#if file.removed > 0}<span class="text-red">−{file.removed}</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}
            {#if expandedGroups[row.key]}
              <div class="ml-1 mt-1 border-l border-line pl-3">
                {#each row.tools as tool (tool.item.key)}
                  {@render toolLine(tool)}
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else}
        {@const item = row.item}
        <div
          data-item-key={item.key}
          class={item.key === highlightedKey ? 'rounded ring-1 ring-amber' : ''}
        >
          {#if item.kind === 'user'}
            <!-- User message: a right-aligned orange bubble; @file mentions are
                 clickable badges that open the file. -->
            <div
              class="agent-sticky-user mb-3 ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-default"
            >
              {#each userSegments(item.text) as segment, segmentIndex (segmentIndex)}
                {#if segment.kind === 'mention'}
                  <button
                    class="mx-0.5 inline rounded bg-black/25 px-1 font-mono text-amber hover:bg-black/40"
                    title={segment.path}
                    onclick={() => openMention(segment.path)}>@{segment.path}</button
                  >
                {:else}{segment.value}{/if}
              {/each}
            </div>
          {:else if item.kind === 'text'}
            <!-- Assistant message: markdown-rendered. -->
            <div class="agent-markdown prose mb-3 max-w-none text-xs text-default">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(item.text)}
            </div>
          {:else if item.kind === 'tool' && TASK_TOOLS.has(item.tool)}
            <!-- Task tool calls fold into the pinned checklist; keep a one-line
                 marker so the timeline shows when statuses changed. -->
            <div class="mb-2 font-mono text-2xs text-dim">
              ☑ {item.tool === 'TaskCreate'
                ? `task: ${item.input.subject || ''}`
                : `task #${item.input.taskId || '?'} → ${item.input.status || 'updated'}`}
            </div>
          {:else if item.kind === 'compact'}
            <!-- Compaction boundary: earlier turns were summarized away. -->
            <div
              class="-mx-3 mb-3 flex items-center gap-2 border-y border-violet/30 bg-violet-soft px-3 py-1.5 text-2xs text-violet"
            >
              <span class="font-medium">✦ Conversation compacted</span>
              {#if item.freedTokens > 0}
                <span class="text-dim">· freed {(item.freedTokens / 1000).toFixed(1)}k tokens</span>
              {/if}
            </div>
          {:else if item.kind === 'raw'}
            <pre class="mb-1 whitespace-pre-wrap font-mono text-2xs text-muted">{item.text}</pre>
          {/if}
        </div>
      {/if}
{/snippet}

<FloatingScrollbar class="min-h-0 flex-1" bind:viewport {onscroll}>
  <div class="px-3 py-3 text-xs leading-relaxed">
    {#each sections as section (section.key)}
      <!-- The section box is the sticky header's containing block, so the pinned
           user bubble scrolls away with its own turn instead of stacking. -->
      <div>
        {#if section.header}
          <div class="sticky top-0 z-10">
            {@render renderRow(section.header)}
          </div>
        {/if}
        {#each section.body as row (rowKey(row))}
          {@render renderRow(row)}
        {/each}
      </div>
    {/each}
    {#if items.length === 0}
      <p class="text-dim">No agent output yet. Write a prompt below and run.</p>
    {/if}
  </div>
</FloatingScrollbar>
