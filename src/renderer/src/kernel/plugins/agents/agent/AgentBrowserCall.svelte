<script lang="ts">
  // One `browser` call, drawn as what it did in the page rather than as the
  // protocol command it was: navigate to a URL, click at a point, type some
  // text. Under it, the page's URL afterwards and what the page logged in the
  // meantime — folded away unless something in it went wrong.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import CodeBlock from '../../../../components/CodeBlock.svelte'
  import ShimmerText from '../../../../components/ShimmerText.svelte'
  import { blobUrl } from '../../../../lib/agents/api'
  import {
    browserActionOf,
    browserReplyOf,
    logHasErrors,
    prettyJson,
    valueOf
  } from '../../../../lib/agents/browserCalls'
  import type { ToolItem, ToolStatus } from '../../../../lib/agents/transcript'
  import AgentImage from './AgentImage.svelte'

  let {
    item,
    sessionId,
    expanded,
    onToggle
  }: {
    item: ToolItem
    /** The session the call ran in, which its screenshot is stored under. */
    sessionId: string
    expanded: boolean
    onToggle: () => void
  } = $props()

  // The user may have rewritten the arguments before approving; what ran is what matters.
  const action = $derived.by(() => {
    if (item.editedInput !== undefined && item.editedInput !== null) {
      return browserActionOf(item.editedInput)
    }
    return browserActionOf(item.input)
  })
  const replyText = $derived.by(() => {
    if (item.rawResult.length > 0) {
      return item.rawResult
    }
    return item.result
  })
  const reply = $derived(browserReplyOf(replyText))
  const value = $derived(valueOf(action, reply))
  const failed = $derived(item.status === 'error' || item.status === 'denied')
  const hasCode = $derived(action.kind === 'evaluate' || action.kind === 'script')

  // Where the page ended up, unless the row already says it: a navigation
  // leads with the URL it went to.
  const urlAfter = $derived.by(() => {
    if (reply.url === action.detail) {
      return ''
    }
    return reply.url
  })

  const logLength = $derived(reply.console.length + reply.failedRequests.length)
  const logErrors = $derived(logHasErrors(reply))
  // The user's choice once they made one; until then the log is open only when
  // it has errors in it.
  let logChoice = $state<boolean | null>(null)
  const logOpen = $derived.by(() => {
    if (logChoice === null) {
      return logErrors
    }
    return logChoice
  })

  /** Opens or closes the page's log for this call. */
  function toggleLog(): void {
    logChoice = !logOpen
  }

  /** How the log toggle counts what is in it: its errors when it has any, else its lines. */
  function logLabel(): string {
    if (!logErrors) {
      return `${logLength} logged`
    }
    const errors = reply.console.filter((line) => line.isError).length + reply.failedRequests.length
    if (errors === 1) {
      return '1 error'
    }
    return `${errors} errors`
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
  <div class="flex min-w-0 items-center gap-2 font-mono text-2xs">
    <button
      class="flex min-w-0 flex-1 items-center gap-2 text-left"
      onclick={onToggle}
      title="{action.method || 'script'}: expand the call"
    >
      <span
        class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
        class:rotate-90={expanded}
      >
        <CaretRight width="10" height="10" weight="bold" />
      </span>
      {#if item.status === 'running'}
        <ShimmerText text={action.verb} class="shrink-0 font-semibold" />
      {:else}
        <span class="shrink-0 font-semibold {STATUS_COLOR[item.status]}">{action.verb}</span>
      {/if}
      {#if action.kind === 'type'}
        <span class="min-w-0 truncate text-default">“{action.detail}”</span>
      {:else if action.kind === 'key'}
        <kbd class="shrink-0 rounded border border-line bg-surface px-1 text-default"
          >{action.detail}</kbd
        >
      {:else if action.detail}
        <span class="min-w-0 truncate" class:text-default={!hasCode} class:text-muted={hasCode}
          >{action.detail}</span
        >
      {/if}
    </button>
    {#if urlAfter}
      <span class="min-w-0 max-w-[45%] shrink truncate text-dim" title={reply.title || urlAfter}
        >{urlAfter}</span
      >
    {/if}
    {#if logLength > 0}
      <button
        class="shrink-0 rounded px-1 hover:bg-hover"
        class:text-red={logErrors}
        class:text-dim={!logErrors}
        title="What the page logged during this call"
        onclick={toggleLog}>{logLabel()}</button
      >
    {/if}
  </div>

  {#if failed && reply.value}
    <!-- The protocol's own words for what went wrong: the reason to look at the row. -->
    <pre class="mt-0.5 whitespace-pre-wrap pl-4 font-mono text-2xs text-red">{reply.value}</pre>
  {:else if hasCode && value.text && !expanded}
    <div
      class="truncate pl-4 font-mono text-2xs"
      class:text-red={value.isError}
      class:text-muted={!value.isError}
    >
      <span class="text-dim">→</span>
      {value.text}
    </div>
  {/if}

  {#if expanded}
    {#if hasCode}
      <CodeBlock
        code={action.code}
        language="javascript"
        class="ml-4 mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted"
      />
      {#if value.text}
        <pre
          class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs"
          class:text-red={value.isError}
          class:text-muted={!value.isError}><span class="text-dim">→ </span>{prettyJson(
            value.text
          )}</pre>
      {/if}
    {:else}
      <!-- Anything else: the command as sent and what came back. -->
      <div class="mt-1 pl-4 font-mono text-2xs text-dim">{action.method}</div>
      {#if Object.keys(action.params).length > 0}
        <pre
          class="max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-muted">{JSON.stringify(
            action.params,
            null,
            2
          )}</pre>
      {/if}
      {#if value.text && !failed}
        <pre
          class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-muted"><span
            class="text-dim">→ </span>{prettyJson(value.text)}</pre>
      {/if}
    {/if}
  {/if}

  {#if logOpen && logLength > 0}
    <div class="ml-4 mt-1 border-l-2 border-line pl-2 font-mono text-2xs">
      {#if reply.leftOut > 0}
        <div class="text-dim">{reply.leftOut} earlier left out</div>
      {/if}
      {#each reply.console as line, index (index)}
        <div class="truncate" class:text-red={line.isError} class:text-dim={!line.isError} title={line.text}>
          {line.text}
        </div>
      {/each}
      {#each reply.failedRequests as line, index (index)}
        <div class="truncate text-red" title={line.text}>{line.text}</div>
      {/each}
    </div>
  {/if}

  {#if item.images.length > 0}
    <div class="mt-1 flex flex-wrap gap-1.5 pl-4">
      {#each item.images as image (image.ref)}
        <AgentImage src={blobUrl(sessionId, image.ref)} alt="Screenshot of the preview" />
      {/each}
    </div>
  {/if}
</div>
