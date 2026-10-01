<script lang="ts">
  // A run of consecutive `browser` calls as one block. Collapsed, it is what
  // the agent ended up seeing — the last screenshot it took — under one line
  // that counts the calls and says where the page is; open, it is each call as
  // the action it was.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import ShimmerText from '../../../../components/ShimmerText.svelte'
  import { blobUrl } from '../../../../lib/agents/api'
  import { browserReplyOf } from '../../../../lib/agents/browserCalls'
  import type { ToolItem } from '../../../../lib/agents/transcript'
  import AgentBrowserCall from './AgentBrowserCall.svelte'
  import AgentImage from './AgentImage.svelte'

  let {
    items,
    sessionId,
    open,
    onToggle,
    expandedTools,
    toggleTool
  }: {
    items: ToolItem[]
    sessionId: string
    open: boolean
    onToggle: () => void
    expandedTools: Record<string, boolean>
    toggleTool: (toolUseId: string) => void
  } = $props()

  const running = $derived(items.some((call) => call.status === 'running'))
  const failures = $derived(
    items.filter((call) => call.status === 'error' || call.status === 'denied').length
  )
  const lastCall = $derived(items[items.length - 1])
  const lastScreenshot = $derived(lastImageOf(items))
  const pageUrl = $derived(lastUrlOf(items))

  /** The newest picture any call in the block returned, or null. */
  function lastImageOf(calls: ToolItem[]): { call: ToolItem; ref: string } | null {
    for (let index = calls.length - 1; index >= 0; index--) {
      const images = calls[index].images
      if (images.length > 0) {
        return { call: calls[index], ref: images[images.length - 1].ref }
      }
    }
    return null
  }

  /** Where the page was after the newest call that said. */
  function lastUrlOf(calls: ToolItem[]): string {
    for (let index = calls.length - 1; index >= 0; index--) {
      const url = browserReplyOf(replyTextOf(calls[index])).url
      if (url.length > 0) {
        return url
      }
    }
    return ''
  }

  /** A call's reply as the tool wrote it, before the harness dressed it. */
  function replyTextOf(call: ToolItem): string {
    if (call.rawResult.length > 0) {
      return call.rawResult
    }
    return call.result
  }

  /** How many calls the block holds, as its header says it. */
  function countLabel(count: number): string {
    if (count === 1) {
      return '1 call'
    }
    return `${count} calls`
  }
</script>

<div class="mb-1">
  <button
    class="flex w-full min-w-0 items-center gap-2 text-left font-mono text-2xs"
    onclick={onToggle}
    title="Show every call in this block"
  >
    <span
      class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
      class:rotate-90={open}
    >
      <CaretRight width="10" height="10" weight="bold" />
    </span>
    {#if running}
      <ShimmerText text="browser" class="shrink-0 font-semibold" />
    {:else}
      <span class="shrink-0 font-semibold text-muted">browser</span>
    {/if}
    <span class="shrink-0 text-dim">{countLabel(items.length)}</span>
    {#if failures > 0}
      <span class="shrink-0 text-red">{failures} failed</span>
    {/if}
    {#if pageUrl}
      <span class="min-w-0 truncate text-dim" title={pageUrl}>{pageUrl}</span>
    {/if}
  </button>

  {#if open}
    <div class="pl-4">
      {#each items as call (call.eventId)}
        <AgentBrowserCall
          item={call}
          {sessionId}
          expanded={Boolean(expandedTools[call.toolUseId])}
          onToggle={() => toggleTool(call.toolUseId)}
        />
      {/each}
    </div>
  {:else}
    {#if running}
      <!-- The block is still growing: what it is doing right now. -->
      <div class="pl-4">
        <AgentBrowserCall
          item={lastCall}
          {sessionId}
          expanded={Boolean(expandedTools[lastCall.toolUseId])}
          onToggle={() => toggleTool(lastCall.toolUseId)}
        />
      </div>
    {/if}
    {#if lastScreenshot && !(running && lastScreenshot.call === lastCall)}
      <div class="mt-1 flex pl-4">
        <AgentImage src={blobUrl(sessionId, lastScreenshot.ref)} alt="Screenshot of the preview" />
      </div>
    {/if}
  {/if}
</div>
