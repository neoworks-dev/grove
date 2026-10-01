<script lang="ts">
  // One tool call: a collapsed header line that expands to its input and result.
  //
  // How a call renders is data, not code — a tool ships a `display` descriptor with
  // each tool (GET /v1/tools), and a tool this pane has never heard of gets the
  // same treatment as a builtin.

  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import Icon from '@iconify/svelte'
  import CodeBlock from '../../../../components/CodeBlock.svelte'
  import ShimmerText from '../../../../components/ShimmerText.svelte'
  import { layout } from '../../../../lib/layout.svelte'
  import { panels } from '../../../../lib/panels.svelte'
  import { outputTail } from '../../../../lib/agents/outputTail'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import { fileIcon } from '../../../../lib/icons'
  import { formatShellCommand } from '../../../../lib/shellSyntax.svelte'
  import { diffLines, fileDiffsOf, hunksOf, statsOf } from '../../../../lib/agents/diff'
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
  import { blobUrl } from '../../../../lib/agents/api'
  import AgentImage from './AgentImage.svelte'
  import AgentDiffPreview, { type FileChange } from './AgentDiffPreview.svelte'

  let {
    item,
    sessionId,
    display,
    root = '',
    expanded,
    onToggle,
    onOpenFile,
    agentSessionId = null,
    onOpenSession
  }: {
    item: ToolItem
    /** The session the call ran in, which the images it returned are stored under. */
    sessionId: string
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
  // What the call does, in words, when its tool says: "Start agent" over `spawn_agent`.
  const name = $derived(display?.title || item.name)
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

  // Lines of unchanged text kept around each change in the preview.
  const PREVIEW_CONTEXT_LINES = 2

  // The files the call changed, as its harness reported them. A call that was
  // refused or failed changed nothing, so it shows no preview.
  const fileChanges = $derived.by<FileChange[]>(() => {
    if (item.status === 'denied' || item.status === 'error') {
      return []
    }
    return fileDiffsOf(item.content).map((diff) => ({
      path: diff.path,
      hunks: hunksOf(diff.oldText, diff.newText, PREVIEW_CONTEXT_LINES)
    }))
  })

  const diffStats = $derived.by(() => {
    if (fileChanges.length > 0) {
      return statsOf(fileChanges.flatMap((change) => change.hunks.flat()))
    }
    let added = 0
    let removed = 0
    for (const edit of edits) {
      const stats = statsOf(diffLines(edit.oldText, edit.newText))
      added += stats.added
      removed += stats.removed
    }
    return { added, removed }
  })

  // The diff is what a file-changing call's arguments mean; the raw arguments
  // under it would only say the same thing less readably.
  const showsInput = $derived(fileChanges.length === 0 || inputView !== 'json')

  const resultLines = $derived(item.result.length === 0 ? [] : item.result.split('\n'))

  // What the command has printed so far, when its harness streams it.
  const LIVE_TAIL_LINES = 6
  const liveOutput = $derived(
    inputView === 'command' ? shellOutputs.of(sessionId, item.toolUseId) : undefined
  )
  const liveTail = $derived(liveOutput ? outputTail(liveOutput.text, LIVE_TAIL_LINES) : [])

  /** Shows the session's commands in the bottom panel's agent terminal tab. */
  function openAgentTerminal(): void {
    panels.reveal('agent-shell')
    layout.ensurePane('panel')
  }

  /** The one field a `code` or `command` view is about. */
  function contentOf(view: 'code' | 'command'): string {
    const record = asRecord(input)
    if (record === null) return ''
    if (view === 'command') return stringOf(record.command)
    return stringOf(record.content)
  }

  // A command as written is one long line — four greps and a pipeline, past the
  // width of any pane it lands in. Laid out from its syntax it can be read;
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
      {#if item.status === 'running'}
        <!-- The working bar steps aside while a call runs; the call says it is busy. -->
        <ShimmerText text={name} class="shrink-0 font-semibold" />
      {:else}
        <span class="shrink-0 font-semibold {STATUS_COLOR[item.status]}" title={item.name}
          >{name}</span
        >
      {/if}
      {#if inputView === 'message' && message.to}
        <!-- Who the message is for reads better than the tool's arguments do. -->
        <span class="shrink-0 rounded bg-blue-soft px-1 text-blue">→ {message.to}</span>
      {/if}
      {#if pathLabel === null}
        <!-- The description is what the call is for: one line, never cut. The
             arguments take whatever room is left and truncate. -->
        {#if description}<span class="shrink-0 whitespace-nowrap text-muted">{description}</span
          >{/if}
        {#if detail && !(inputView === 'message' && detail === message.to)}
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

  {#if liveOutput && (item.status === 'running' || liveOutput.running)}
    <!-- A command's last lines as it prints them; the whole of it is in the
         session's terminal. A command sent to the background keeps this after
         its call has returned, for as long as it runs. -->
    <div
      class="ml-4 mt-1 rounded border border-line bg-surface px-2 py-1 font-mono text-2xs text-dim"
    >
      {#each liveTail as line, index (index)}
        <div class="truncate whitespace-pre">{line || ' '}</div>
      {:else}
        <div class="italic">No output yet</div>
      {/each}
      <div class="mt-1 flex gap-1.5 font-sans">
        <button
          class="rounded border border-line px-1.5 hover:bg-hover hover:text-default"
          title="Everything this session's commands printed"
          onclick={openAgentTerminal}
        >
          Open in terminal
        </button>
        {#if liveOutput.running}
          <button
            class="rounded border border-line px-1.5 hover:bg-hover hover:text-red"
            title="Stop the command, as Ctrl+C would"
            onclick={() => shellOutputs.interrupt(sessionId, item.toolUseId)}
          >
            Stop
          </button>
        {/if}
      </div>
    </div>
  {:else if item.progress && item.status === 'running'}
    <div class="pl-4 font-mono text-2xs text-dim">{item.progress}</div>
  {/if}

  <AgentDiffPreview changes={fileChanges} {root} />

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
      <!-- A message, laid out as one: quoted under the row that names who it is for. -->
      <div class="ml-4 mt-1 whitespace-pre-wrap border-l-2 border-line pl-2 text-2xs text-muted">
        {message.text}
      </div>
    {:else if inputView === 'code' || inputView === 'command'}
      <CodeBlock
        code={shownInput}
        language={inputLanguage}
        class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted"
      />
    {:else if inputView === 'json' && showsInput}
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

  <!-- Images the tool returned stay on screen collapsed or not: a screenshot is
       the thing the call was for. -->
  {#if item.images.length > 0}
    <div class="mt-1 flex flex-wrap gap-1.5 pl-4">
      {#each item.images as image (image.ref)}
        <AgentImage src={blobUrl(sessionId, image.ref)} alt="{item.name} result" />
      {/each}
    </div>
  {/if}
</div>
