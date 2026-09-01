<script lang="ts">
  // The conversation. Items come from the transcript fold, already reduced to what should
  // be on screen; this decides what each one looks like.
  //
  // Rows are grouped into sections, one per user message, and each section owns
  // its user bubble as a sticky header: because the sticky element's containing
  // block is the section box rather than the whole transcript, the header pins
  // only while its own turn is on screen and scrolls away with it.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { renderMarkdown } from '../../../../lib/markdown'
  import { blobUrl } from '../../../../lib/agents/api'
  import { tallyOf, toTranscriptRows, type ToolRunRow } from '../../../../lib/agents/toolRuns'
  import type { TranscriptItem } from '../../../../lib/agents/transcript'
  import type { ToolInfo } from '../../../../lib/agents/types'
  import AgentToolCall from './AgentToolCall.svelte'
  import AgentSurface from './AgentSurface.svelte'

  let {
    sessionId,
    items,
    tools,
    expandedTools,
    toggleTool,
    onOpenFile,
    viewport = $bindable(),
    onscroll
  }: {
    sessionId: string
    items: TranscriptItem[]
    tools: ToolInfo[]
    expandedTools: Record<string, boolean>
    toggleTool: (toolUseId: string) => void
    onOpenFile: (path: string) => void
    viewport?: HTMLDivElement
    onscroll: () => void
  } = $props()

  interface Section {
    key: string
    header: TranscriptItem | null
    body: TranscriptItem[]
  }

  const sections = $derived.by<Section[]>(() => {
    const result: Section[] = []
    let current: Section = { key: 'lead', header: null, body: [] }
    for (const item of items) {
      if (item.kind !== 'user') {
        current.body.push(item)
        continue
      }
      if (current.header || current.body.length > 0) result.push(current)
      current = { key: item.eventId, header: item, body: [] }
    }
    if (current.header || current.body.length > 0) result.push(current)
    return result
  })

  // Runs of finished tool calls collapse into one line, so a burst of reads does
  // not push the answer off screen. Which ones the user opened is the pane's own
  // business, so it stays here rather than travelling with the transcript.
  let expandedRuns = $state<Record<string, boolean>>({})

  function toggleRun(key: string): void {
    expandedRuns = { ...expandedRuns, [key]: !expandedRuns[key] }
  }

  function displayOf(name: string): ToolInfo['display'] {
    return tools.find((tool) => tool.name === name)?.display
  }
</script>

{#snippet toolRun(run: ToolRunRow)}
  {@const open = Boolean(expandedRuns[run.key])}
  <div class="mb-1">
    <button
      class="flex w-full min-w-0 items-center gap-2 text-left font-mono text-2xs"
      onclick={() => toggleRun(run.key)}
      title="Show every call in this run"
    >
      <span
        class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
        class:rotate-90={open}
      >
        <CaretRight width="10" height="10" weight="bold" />
      </span>
      {#each tallyOf(run.items) as tally (tally.name)}
        <span class="shrink-0 text-muted">
          {tally.name}{#if tally.count > 1}<span class="text-dim">&nbsp;×{tally.count}</span>{/if}
        </span>
      {/each}
    </button>
    {#if open}
      <div class="pl-4">
        {#each run.items as call (call.eventId)}
          <AgentToolCall
            item={call}
            display={displayOf(call.name)}
            expanded={Boolean(expandedTools[call.toolUseId])}
            onToggle={() => toggleTool(call.toolUseId)}
            {onOpenFile}
          />
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet row(item: TranscriptItem)}
  {#if item.kind === 'user'}
    <div class="agent-sticky-user -mx-3 mb-3 whitespace-pre-wrap px-3 py-2 text-default">
      {item.text}
      {#if item.references.length > 0}
        <!-- The slice itself went to the model; the bubble only names it. -->
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          {#each item.references as reference (`${reference.path}:${reference.startLine}`)}
            <span
              class="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-2xs text-muted"
            >
              {reference.path}:{reference.startLine}-{reference.endLine}
            </span>
          {/each}
        </div>
      {/if}
      {#if item.attachments.length > 0}
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          {#each item.attachments as attachment (attachment.ref)}
            <img
              class="max-h-32 rounded border border-line"
              src={blobUrl(sessionId, attachment.ref)}
              alt="attachment"
            />
          {/each}
        </div>
      {/if}
    </div>
  {:else if item.kind === 'app'}
    <!-- app.message is model-visible but explicitly application-authored, so it
         belongs in a neutral card rather than a sticky user-authored bubble. -->
    <div class="-mx-1 mb-3 rounded-md border border-amber/30 bg-amber-soft px-2.5 py-2">
      <div class="mb-1 text-2xs font-medium uppercase tracking-wide text-amber">
        {item.label}
      </div>
      <div class="whitespace-pre-wrap text-xs text-muted">{item.text}</div>
    </div>
  {:else if item.kind === 'agent'}
    <div class="mb-3">
      {#if item.thinking}
        <!-- Reasoning: present but recessive, so it never competes with the answer. -->
        <details class="mb-1.5">
          <summary class="cursor-pointer text-2xs text-dim hover:text-muted">thinking</summary>
          <div class="mt-1 whitespace-pre-wrap border-l border-line pl-2 text-2xs text-dim">
            {item.thinking}
          </div>
        </details>
      {/if}
      {#if item.text}
        <div class="agent-markdown prose max-w-none text-xs text-default">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(item.text)}
        </div>
      {/if}
    </div>
  {:else if item.kind === 'tool'}
    <AgentToolCall
      {item}
      display={displayOf(item.name)}
      expanded={Boolean(expandedTools[item.toolUseId])}
      onToggle={() => toggleTool(item.toolUseId)}
      {onOpenFile}
    />
  {:else if item.kind === 'shell'}
    <!-- A `!` command the user ran. `shared` decides whether the model saw it. -->
    <div class="mb-2">
      <div class="flex items-center gap-2 font-mono text-2xs">
        <span class="shrink-0 text-blue">$</span>
        <span class="min-w-0 truncate text-muted">{item.command}</span>
        {#if !item.shared}<span class="shrink-0 text-dim">· private</span>{/if}
        {#if item.exitCode !== 0}<span class="shrink-0 text-red">· exit {item.exitCode}</span>{/if}
      </div>
      {#if item.output}
        <pre
          class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-dim">{item.output}</pre>
      {/if}
    </div>
  {:else if item.kind === 'notice'}
    <div
      class="-mx-3 mb-3 border-y px-3 py-2 text-2xs {item.tone === 'error'
        ? 'border-red/30 bg-red-soft text-red'
        : 'border-line bg-elevated text-muted'}"
    >
      <span class="whitespace-pre-wrap">{item.text}</span>
    </div>
  {:else if item.kind === 'commandOutput'}
    <!-- A command the harness ran itself (/usage, /help): its output, verbatim. -->
    <div class="mb-2 rounded-md border border-line bg-elevated px-2.5 py-2">
      <pre
        class="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-2xs text-muted">{item.text}</pre>
    </div>
  {:else if item.kind === 'surface'}
    <AgentSurface node={item.view} />
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
            {@render row(section.header)}
          </div>
        {/if}
        {#each toTranscriptRows(section.body) as bodyRow (bodyRow.key)}
          {#if bodyRow.kind === 'toolRun'}
            {@render toolRun(bodyRow)}
          {:else}
            {@render row(bodyRow.item)}
          {/if}
        {/each}
      </div>
    {/each}
    {#if items.length === 0}
      <p class="text-dim">Nothing yet. Write a prompt below.</p>
    {/if}
  </div>
</FloatingScrollbar>
