<script lang="ts">
  // One tool call: a collapsed header line that expands to its input and result.
  //
  // How a call renders is data, not code — a tool ships a `display` descriptor with
  // each tool (GET /v1/tools), and a tool this pane has never heard of gets the
  // same treatment as a builtin.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import Icon from '@iconify/svelte'
  import CodeBlock from '../../../../components/CodeBlock.svelte'
  import { fileIcon } from '../../../../lib/icons'
  import { formatShellCommand } from '../../../../lib/shellFormat'
  import { diffLines, statsOf } from '../../../../lib/agents/diff'
  import {
    descriptionOf,
    editsOf,
    fileOfCall,
    inputViewOf,
    labelFor,
    languageOfInput,
    messageOf,
    pathLabelOf,
    resultViewOf,
    stringOf,
    asRecord
  } from '../../../../lib/agents/tools'
  import type { ToolItem, ToolStatus } from '../../../../lib/agents/transcript'
  import type { ToolDisplay } from '../../../../lib/agents/types'

  let {
    item,
    display,
    root = '',
    expanded,
    onToggle,
    onOpenFile,
    agentSessionId = null,
    onOpenSession
  }: {
    item: ToolItem
    display: ToolDisplay | undefined
    /** The workspace the session runs in; paths under it are shown relative to it. */
    root?: string
    expanded: boolean
    onToggle: () => void
    onOpenFile: (path: string) => void
    /** The session holding the conversation this call ran, when it ran an agent. */
    agentSessionId?: string | null
    onOpenSession?: (sessionId: string) => void
  } = $props()

  // The user may have rewritten the arguments before approving; what ran is what
  // matters.
  const input = $derived(item.editedInput ?? item.input)
  const label = $derived(labelFor(display, input))
  const inputView = $derived(inputViewOf(display))
  const resultView = $derived(resultViewOf(display))
  const language = $derived(languageOfInput(display, input))

  // A call about a file leads with the file name and an icon for its type; the
  // directory follows it, dimmed, because it is the part every row repeats. A
  // command is never a path, however single-token it looks.
  const pathLabel = $derived.by(() => {
    if (inputView === 'command') {
      return null
    }
    return pathLabelOf(label, root)
  })

  // What the model said it was doing leads the row; the arguments follow it,
  // dimmed, since "run the formatter" reads faster than the command line does.
  const description = $derived(descriptionOf(input))
  const detail = $derived.by(() => {
    if (description.length === 0 || label !== description) {
      return label
    }
    // The fallback label picked the description; the command is what is left to show.
    const fields = asRecord(input)
    if (fields === null) {
      return ''
    }
    return stringOf(fields.command)
  })

  // A row that leads with a file name opens that file on click.
  const filePath = $derived(fileOfCall(display, input, root))

  // A message between agents: the addressee and the body, shown as a note
  // rather than as arguments.
  const message = $derived(messageOf(input))

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

  // A command as written is one long line — four greps and a pipeline, past the
  // width of any pane it lands in. Broken at its own operators it can be read;
  // what runs is untouched.
  const shownInput = $derived.by(() => {
    if (inputView === 'command') return formatShellCommand(contentOf('command'))
    if (inputView === 'code') return contentOf('code')
    return ''
  })

  // A command is shell whatever the tool called the field; anything else names
  // its own language, or has none and stays plain.
  const inputLanguage = $derived(inputView === 'command' ? 'shell' : language)

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
    <!-- The caret and the tool name expand the call; a file name beside them is
         its own target that opens the file, which is what a reader reaches for. -->
    <button
      class="flex min-w-0 items-center gap-2 text-left font-mono text-2xs"
      class:flex-1={pathLabel === null}
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
      {#if inputView === 'message' && message.to}
        <!-- Who the message is for reads better than the tool's arguments do. -->
        <span class="shrink-0 rounded bg-blue-soft px-1 text-blue">→ {message.to}</span>
      {/if}
      {#if pathLabel === null}
        {#if description}<span class="min-w-0 truncate text-muted">{description}</span>{/if}
        {#if detail}
          <span
            class="min-w-0 truncate"
            class:text-dim={description.length > 0}
            class:text-muted={description.length === 0}>{detail}</span
          >
        {/if}
      {/if}
    </button>
    {#if pathLabel && filePath}
      <button
        class="group flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-2xs"
        onclick={() => onOpenFile(filePath)}
        title="Open {filePath}"
      >
        <Icon icon={fileIcon(pathLabel.name)} width="12" height="12" class="shrink-0" />
        <span class="shrink-0 text-default group-hover:underline">{pathLabel.name}</span>
        {#if pathLabel.directory}
          <span class="truncate text-dim group-hover:underline">{pathLabel.directory}</span>
        {/if}
      </button>
    {/if}
    <!-- A call that ran an agent has a conversation behind it, one tab along. -->
    {#if agentSessionId}
      <button
        class="shrink-0 rounded border border-line px-1.5 text-2xs text-dim hover:bg-hover hover:text-default"
        title="Open the conversation this call ran"
        onclick={() => onOpenSession?.(agentSessionId)}
      >
        open ↗
      </button>
    {/if}
    {#if diffStats.added > 0}<span class="shrink-0 font-mono text-2xs text-green"
        >+{diffStats.added}</span
      >{/if}
    {#if diffStats.removed > 0}<span class="shrink-0 font-mono text-2xs text-red"
        >−{diffStats.removed}</span
      >{/if}
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
    {:else if inputView === 'message'}
      <!-- A message, laid out as one: the addressee above the body, on a card
           tinted like the channel it travels on. -->
      <div class="mt-1 rounded-md border border-blue/25 bg-blue-soft px-2 py-1.5">
        {#if message.to}
          <div class="mb-1 font-mono text-2xs text-blue">to {message.to}</div>
        {/if}
        <div class="whitespace-pre-wrap text-2xs text-muted">{message.text}</div>
      </div>
    {:else if inputView === 'code' || inputView === 'command'}
      <CodeBlock
        code={shownInput}
        language={inputLanguage}
        class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted"
      />
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
      {:else if resultView === 'code' && item.status !== 'error'}
        <!-- A file the agent read: the contents are the whole point of the call,
             so they are shown the way the editor would show them. -->
        <CodeBlock
          code={item.result}
          {language}
          class="mb-1 mt-1 max-h-60 overflow-auto whitespace-pre-wrap py-1 pl-4 font-mono text-2xs text-dim"
        />
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
