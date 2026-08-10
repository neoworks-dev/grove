<script lang="ts">
  // The conversation. Items come from nib's fold, already reduced to what should
  // be on screen; this decides what each one looks like.
  //
  // Rows are grouped into sections, one per user message, and each section owns
  // its user bubble as a sticky header: because the sticky element's containing
  // block is the section box rather than the whole transcript, the header pins
  // only while its own turn is on screen and scrolls away with it.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { renderMarkdown } from '../../lib/markdown'
  import { blobUrl } from '../../lib/nib/api'
  import type { TranscriptItem } from '../../lib/nib/transcript'
  import type { ToolInfo } from '../../lib/nib/types'
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

  function displayOf(name: string): ToolInfo['display'] {
    return tools.find((tool) => tool.name === name)?.display
  }
</script>

{#snippet row(item: TranscriptItem)}
  {#if item.kind === 'user'}
    <!-- Typed by the user: a left-aligned bubble, with any attached images. -->
    <div
      class="agent-sticky-user mb-3 w-fit max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-default"
    >
      {item.text}
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
        {#each section.body as item (item.eventId)}
          {@render row(item)}
        {/each}
      </div>
    {/each}
    {#if items.length === 0}
      <p class="text-dim">Nothing yet. Write a prompt below.</p>
    {/if}
  </div>
</FloatingScrollbar>
