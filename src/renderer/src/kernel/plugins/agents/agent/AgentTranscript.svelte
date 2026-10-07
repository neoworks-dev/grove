<script lang="ts">
  // The conversation. Items come from the transcript fold, already reduced to what should
  // be on screen; this decides what each one looks like.
  //
  // Rows are grouped into sections, one per user message, and each section owns
  // its user bubble as a sticky header: because the sticky element's containing
  // block is the section box rather than the whole transcript, the header pins
  // only while its own turn is on screen and scrolls away with it.

  import type { Snippet } from 'svelte'
  import Icon from '@iconify/svelte'
  import CaretRight from 'phosphor-svelte/lib/CaretRight'
  import PaperPlaneTilt from 'phosphor-svelte/lib/PaperPlaneTilt'
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { fileIcon } from '../../../../lib/icons'
  import { renderMarkdown } from '../../../../lib/markdown'
  import { floatingCodeScrollbars } from '../../../../lib/markdownScrollbars'
  import { highlightCodeFences } from '../../../../lib/markdownHighlight'
  import { linkCodeReferences } from '../../../../lib/agents/codeReferenceLinks'
  import type { CodeReference } from '../../../../lib/agents/codeReferences'
  import { blobUrl } from '../../../../lib/agents/api'
  import {
    tallyOf,
    toItemRows,
    turnRows,
    type CallGroupRow,
    type ToolRunRow,
    type ToolTally,
    type TranscriptRow
  } from '../../../../lib/agents/toolRuns'
  import { displayOfCall, fileOfCall, pathLabelOf } from '../../../../lib/agents/tools'
  import { changedFilesOf, type ChangedFile } from '../../../../lib/agents/changedFiles'
  import { foldedCalls, foldedMessages, foldTurn } from '../../../../lib/agents/turns'
  import { agentIdIn, senderOf } from '../../../../lib/agents/transcript'
  import type { ToolItem, TranscriptItem, UserItem } from '../../../../lib/agents/transcript'
  import type { CodeLocation, LocationState, ToolInfo } from '../../../../lib/agents/types'
  import AgentImage from './AgentImage.svelte'
  import AgentMessageCards from './AgentMessageCards.svelte'
  import AgentToolCall from './AgentToolCall.svelte'
  import AgentShellRun from './AgentShellRun.svelte'
  import AgentCompaction from './AgentCompaction.svelte'
  import AgentBrowserCall from './AgentBrowserCall.svelte'
  import AgentBrowserGroup from './AgentBrowserGroup.svelte'
  import { BROWSER_TOOL, isBrowserCall } from '../../../../lib/agents/browserCalls'
  import AgentSurface from './AgentSurface.svelte'
  import { clearReveal, transcriptReveal } from '../../../../lib/agents/transcriptReveal.svelte'
  import { sectionHolding } from '../../../../lib/agents/sectionHolding'
  import { sectionsOf, type TranscriptSection } from '../../../../lib/agents/sections'

  let {
    sessionId,
    items,
    tools,
    root = '',
    expandedTools,
    thinking,
    turnInFlightSince,
    toggleTool,
    onOpenFile,
    onOpenLocation,
    onOpenAgent,
    onOpenSession,
    subagentSessions,
    liveAgentIds,
    canEdit,
    onEditMessage,
    viewport = $bindable(),
    onscroll,
    footer
  }: {
    sessionId: string
    items: TranscriptItem[]
    tools: ToolInfo[]
    /** The worktree the session runs in; tool calls show their paths relative to it. */
    root?: string
    expandedTools: Record<string, boolean>
    /** The agent is working and has nothing on screen yet to show for it. */
    thinking: boolean
    /**
     * The seq the turn in flight started at, null when idle. Its rows stay expanded so
     * the work can be watched, across every section a steered message opened in it.
     */
    turnInFlightSince: number | null
    toggleTool: (toolUseId: string) => void
    onOpenFile: (path: string) => void
    /** Open a place an agent pointed at, with its lines marked. */
    onOpenLocation: (location: CodeLocation, state?: LocationState) => void
    /** Show the conversation of the agent a message came from. */
    onOpenAgent: (agentId: string) => void
    /** Show one session: the conversation a tool call ran, from the call itself. */
    onOpenSession: (sessionId: string) => void
    /** The session each tool call that ran an agent produced, by tool-use id. */
    subagentSessions: Map<string, string>
    /** Every agent that still exists; a sender missing from it has been closed. */
    liveAgentIds: Set<string>
    /** Whether a sent message can be edited, the conversation rerun from it. */
    canEdit: (item: UserItem) => boolean
    /** Replace a sent message with `text`, dropping it and everything after it. */
    onEditMessage: (item: UserItem, text: string) => void
    viewport?: HTMLDivElement
    onscroll: () => void
    /** The last row of the flow, after the newest item: what the agent is doing now. */
    footer?: Snippet
  } = $props()

  type Section = TranscriptSection

  const sections = $derived(sectionsOf(items, turnInFlightSince))

  /** Where a section starts, for finding the one a seq falls in. */
  function sectionStart(section: Section): { key: string; startSeq: number | null } {
    let first: TranscriptItem | undefined = section.body[0]
    if (section.header) first = section.header
    if (!first) return { key: section.key, startSeq: null }
    return { key: section.key, startSeq: first.seq }
  }

  // Something outside the pane — a blamed line, a commit's prompt — asked for a
  // turn of this session. Scrolled to once its section is on screen.
  $effect(() => {
    const target = transcriptReveal.seq
    if (target === null || transcriptReveal.sessionId !== sessionId || !viewport) return
    const key = sectionHolding(sections.map(sectionStart), target)
    if (!key) return
    const element = viewport.querySelector(`[data-section="${CSS.escape(key)}"]`)
    if (!(element instanceof HTMLElement)) return
    element.scrollIntoView({ block: 'start' })
    clearReveal()
  })

  // Runs of finished tool calls in a settled turn collapse into one line, so a burst of
  // reads does not push the answer off screen. Which ones the user opened is the pane's
  // own business, so it stays here rather than travelling with the transcript.
  let expandedRuns = $state<Record<string, boolean>>({})

  function toggleRun(key: string): void {
    expandedRuns = { ...expandedRuns, [key]: !expandedRuns[key] }
  }

  /** Opens a path the agent named in its text, marking the lines it gave. */
  function openReference(reference: CodeReference): void {
    onOpenLocation({ path: reference.path, startLine: reference.line, endLine: reference.endLine })
  }

  function displayOf(call: ToolItem): ToolInfo['display'] {
    return displayOfCall(tools, call)
  }

  /**
   * Calls that break a run of calls rather than fold into it: each change to a file,
   * with the file it changed, and a call whose images are its point. A folded turn
   * goes further and hides edits too — see `standsAloneWhenFolded`.
   */
  function standsAlone(call: ToolItem): boolean {
    if (displayOf(call)?.edits === true) {
      return true
    }
    return call.images.length > 0
  }

  /** Whether a call changes files: those leave the summary line for the list of changed files. */
  function changesFiles(call: ToolItem): boolean {
    return displayOf(call)?.edits === true
  }

  /**
   * Calls that keep a row of their own once a turn folds. Edits fold with the rest of
   * the work, since the turn lists the files it changed; an image is its call's point.
   */
  function standsAloneWhenFolded(call: ToolItem): boolean {
    return call.images.length > 0
  }

  /** Calls whose card belongs to the answer, so the prose around them folds as one. */
  function partOfAnswer(call: ToolItem): boolean {
    return displayOf(call)?.answer === true
  }

  /** The block a call joins with its neighbours: browser calls drive one page, so they stay together. */
  function groupOf(call: ToolItem): string | null {
    if (isBrowserCall(call)) {
      return BROWSER_TOOL
    }
    return null
  }

  /** What a folded summary says a run of calls did, file names included. */
  function tallyCalls(calls: ToolItem[]): ToolTally[] {
    return tallyOf(
      calls,
      (call) => fileOfCall(displayOf(call), call.editedInput ?? call.input, root),
      (call) => displayOf(call)?.title || call.name
    )
  }

  /** The files a folded turn changed, each once, from the calls it hid. */
  function changedFilesIn(hidden: TranscriptRow[]): ChangedFile[] {
    const edits = foldedCalls(hidden).filter(changesFiles)
    return changedFilesOf(edits, (call) =>
      fileOfCall(displayOf(call), call.editedInput ?? call.input, root)
    )
  }

  // A turn that is over reads as its answer; the calls and interim messages behind
  // it hide behind one line. Which turns the user opened back up belongs to the
  // pane, like the runs above.
  let expandedTurns = $state<Record<string, boolean>>({})

  function toggleTurn(key: string): void {
    expandedTurns = { ...expandedTurns, [key]: !expandedTurns[key] }
  }

  /** A section's rows: every item on its own while in flight, runs folded once settled. */
  function rowsOf(section: Section, settled: boolean): TranscriptRow[] {
    return turnRows(bodyOf(section), settled, standsAlone, groupOf)
  }

  /**
   * The items a section draws. A call that succeeded and put its result on screen as
   * a surface is left out: the surface is what it did, and its row would only repeat it.
   */
  function bodyOf(section: Section): TranscriptItem[] {
    return section.body.filter((item) => {
      if (item.kind !== 'tool' || item.status !== 'ok') return true
      return displayOf(item)?.surface !== true
    })
  }

  /** What a folded turn says it hid, when it hid no tool calls to name. */
  function stepLabel(count: number): string {
    if (count === 1) return '1 step'
    return `${count} steps`
  }

  function messageLabel(count: number): string {
    if (count === 1) return '1 message'
    return `${count} messages`
  }

  // The message being edited in place, by event id, and what it says so far. The
  // pane's own business until it is sent, like which turns are open.
  let editing = $state<string | null>(null)
  let editDraft = $state('')

  function startEdit(item: UserItem): void {
    editing = item.eventId
    editDraft = item.text
  }

  function cancelEdit(): void {
    editing = null
  }

  /** Whether the draft still says something: text, or the slices and images it carries. */
  function editHasContent(item: UserItem): boolean {
    if (editDraft.trim()) return true
    return item.references.length > 0 || item.attachments.length > 0
  }

  function submitEdit(item: UserItem): void {
    if (!editHasContent(item)) return
    editing = null
    onEditMessage(item, editDraft)
  }

  /** Enter sends, Shift+Enter breaks the line, Escape leaves the message as it was. */
  function onEditKey(event: KeyboardEvent, item: UserItem): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelEdit()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    submitEdit(item)
  }

  /** The editor opens with the caret after the text, ready to type. */
  function focusAtEnd(element: HTMLTextAreaElement): void {
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }

  /** The message a refusal notice offers to reword: its section's, when that one can be edited. */
  function refusedPrompt(header: TranscriptItem | null): UserItem | null {
    if (header?.kind !== 'user') return null
    if (!canEdit(header)) return null
    return header
  }
</script>

{#snippet tallies(list: ToolTally[])}
  {#each list as tally (tally.name)}
    <span class="shrink-0 text-muted">
      {tally.name}{#if tally.count > 1}<span class="text-dim">&nbsp;×{tally.count}</span>{/if}
    </span>
    {#if tally.files.length > 0}
      <span class="flex min-w-0 items-center gap-2 overflow-hidden">
        {#each tally.files as file (file)}
          <span class="flex min-w-0 items-center gap-1 text-default">
            <Icon icon={fileIcon(file)} width="12" height="12" class="shrink-0" />
            <span class="truncate">{file}</span>
          </span>
        {/each}
      </span>
    {/if}
  {/each}
{/snippet}

{#snippet toolCall(call: ToolItem, live: boolean)}
  {#if isBrowserCall(call)}
    <!-- The browser tool reads as what it did in the page, not as its protocol call. -->
    <AgentBrowserCall
      {sessionId}
      item={call}
      expanded={Boolean(expandedTools[call.toolUseId])}
      onToggle={() => toggleTool(call.toolUseId)}
    />
  {:else}
    <AgentToolCall
      {sessionId}
      item={call}
      display={displayOf(call)}
      {root}
      expanded={Boolean(expandedTools[call.toolUseId])}
      onToggle={() => toggleTool(call.toolUseId)}
      {onOpenFile}
      agentSessionId={subagentSessions.get(call.toolUseId) ?? null}
      {onOpenSession}
      {live}
    />
  {/if}
{/snippet}

{#snippet callGroup(group: CallGroupRow)}
  <AgentBrowserGroup
    {sessionId}
    items={group.items}
    open={Boolean(expandedRuns[group.key])}
    onToggle={() => toggleRun(group.key)}
    {expandedTools}
    {toggleTool}
  />
{/snippet}

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
      {@render tallies(tallyCalls(run.items))}
    </button>
    {#if open}
      <div class="pl-4">
        {#each run.items as call (call.eventId)}
          {@render toolCall(call, false)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet turnSummary(key: string, hidden: TranscriptRow[], open: boolean)}
  {@const calls = tallyCalls(foldedCalls(hidden).filter((call) => !changesFiles(call)))}
  {@const messages = foldedMessages(hidden).length}
  <div class="mb-1">
    <button
      class="flex w-full min-w-0 items-center gap-2 text-left font-mono text-2xs"
      onclick={() => toggleTurn(key)}
      title="Show what this turn did"
    >
      <span
        class="inline-flex shrink-0 text-dim transition-transform duration-200 ease-out"
        class:rotate-90={open}
      >
        <CaretRight width="10" height="10" weight="bold" />
      </span>
      {@render tallies(calls)}
      {#if messages > 0}
        <span class="shrink-0 text-dim">{messageLabel(messages)}</span>
      {/if}
      {#if calls.length === 0 && messages === 0}
        <span class="shrink-0 text-dim">{stepLabel(hidden.length)}</span>
      {/if}
    </button>
  </div>
{/snippet}

{#snippet changedFiles(files: ChangedFile[])}
  <!-- What the turn changed stays on screen when its work folds: the calls are
       detail, the files are the outcome. -->
  <div class="mb-3 flex flex-col">
    {#each files as file (file.path)}
      {@const label = pathLabelOf(file.path, root)}
      <button
        class="group flex min-w-0 items-center gap-2 py-px text-left font-mono text-2xs"
        onclick={() => onOpenFile(file.path)}
        title="Open {file.path}"
      >
        <Icon icon={fileIcon(file.path)} width="12" height="12" class="shrink-0" />
        {#if label}
          <span class="shrink-0 text-default group-hover:underline">{label.name}</span>
          {#if label.directory}
            <span class="min-w-0 truncate text-dim group-hover:underline">{label.directory}</span>
          {/if}
        {:else}
          <span class="min-w-0 truncate text-default group-hover:underline">{file.path}</span>
        {/if}
        {#if file.created}<span class="shrink-0 text-dim">new</span>{/if}
        {#if file.added > 0}<span class="shrink-0 text-green">+{file.added}</span>{/if}
        {#if file.removed > 0}<span class="shrink-0 text-red">−{file.removed}</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet row(item: TranscriptItem, live: boolean, header: TranscriptItem | null = null)}
  {#if item.kind === 'user'}
    <div
      class="agent-sticky-user group/user relative -mx-3 mb-3 whitespace-pre-wrap px-3 py-2 text-base text-default"
    >
      {#if editing === item.eventId}
        <!-- Sending drops this message and everything after it, then sends the
             edited one in its place; the slices and images below go with it. -->
        <textarea
          use:focusAtEnd
          class="block max-h-60 min-h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-base [field-sizing:content]"
          bind:value={editDraft}
          onkeydown={(event) => onEditKey(event, item)}
        ></textarea>
        <div class="mt-1.5 flex items-center gap-2 whitespace-normal">
          <button
            class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-50"
            disabled={!editHasContent(item)}
            onclick={() => submitEdit(item)}
          >
            Send
          </button>
          <button
            class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
            onclick={cancelEdit}
          >
            Cancel
          </button>
          <span class="text-2xs text-dim"
            >Everything after this message is dropped from the conversation.</span
          >
        </div>
      {:else}
        {item.text}
        {#if canEdit(item)}
          <button
            class="absolute right-2 top-1.5 rounded p-1 text-dim opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-default focus-visible:opacity-100 group-hover/user:opacity-100"
            title="Edit this message and rerun the conversation from it"
            aria-label="Edit message"
            onclick={() => startEdit(item)}
          >
            <PencilSimple width="12" height="12" />
          </button>
        {/if}
      {/if}
      {#if item.references.length > 0}
        <!-- The slice itself went to the model; the bubble only names it. -->
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          {#each item.references as reference (`${reference.path}:${reference.startLine}`)}
            <span
              class="flex items-center gap-1 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-2xs text-muted"
            >
              <Icon icon={fileIcon(reference.path)} width="12" height="12" class="shrink-0" />
              {reference.path}:{reference.startLine}-{reference.endLine}
            </span>
          {/each}
        </div>
      {/if}
      {#if item.attachments.length > 0}
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          {#each item.attachments as attachment (attachment.ref)}
            <AgentImage src={blobUrl(sessionId, attachment.ref)} alt="attachment" />
          {/each}
        </div>
      {/if}
    </div>
  {:else if item.kind === 'app' && senderOf(item)}
    {@const sender = senderOf(item) ?? ''}
    {@const agentId = agentIdIn(sender)}
    {@const closed = agentId !== null && !liveAgentIds.has(agentId)}
    {#if closed}
      <!-- The agent that said this has since been closed. The message stays —
           it is part of what happened here — but the colour and the click go:
           there is no conversation left to open, and a row that still looked
           like a way through to one would be a dead end. -->
      <div class="mb-3 flex w-full gap-2 border-l-2 border-line pl-2.5">
        <span class="mt-0.5 shrink-0 text-dim">
          <PaperPlaneTilt width="12" height="12" weight="fill" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="mb-0.5 flex items-center gap-1.5 font-mono text-2xs text-dim">
            <span class="truncate">{sender}</span>
            <span class="shrink-0 rounded-sm bg-elevated px-1">closed</span>
          </div>
          <div class="whitespace-pre-wrap text-base text-muted">{item.text}</div>
        </div>
      </div>
    {:else}
      <!-- Another agent talking: read as a message, with the sender leading it and
           the words themselves in the same weight as an answer. Marked with a rule
           rather than a card, so a conversation between agents reads as a thread
           instead of as a stack of boxes. Clicking it opens that agent's own
           conversation, which is where the rest of what it did can be read. -->
      <button
        class="group/message mb-3 flex w-full gap-2 border-l-2 border-blue/50 pl-2.5 text-left transition-all duration-150 ease-out"
        class:cursor-default={agentId === null}
        class:cursor-pointer={agentId !== null}
        class:hover:border-blue={agentId !== null}
        class:hover:pl-3.5={agentId !== null}
        disabled={agentId === null}
        title={agentId ? `Open ${sender}` : undefined}
        onclick={() => agentId && onOpenAgent(agentId)}
      >
        <!-- The plane leans into the hover, so the row reads as a way through to
             the conversation it came from rather than as a static note. -->
        <span
          class="mt-0.5 shrink-0 text-blue transition-transform duration-150 ease-out group-hover/message:translate-x-0.5"
        >
          <PaperPlaneTilt width="12" height="12" weight="fill" />
        </span>
        <div class="min-w-0 flex-1">
          <div
            class="mb-0.5 font-mono text-2xs text-blue/80 transition-colors duration-150 group-hover/message:text-blue"
          >
            {sender}
          </div>
          <div class="whitespace-pre-wrap text-base text-default">{item.text}</div>
        </div>
      </button>
    {/if}
  {:else if item.kind === 'app'}
    <!-- grove itself talking — review feedback, a task brief — which is
         model-visible but authored by neither side of the conversation. -->
    <div class="-mx-1 mb-3 rounded-md border border-amber/30 bg-amber-soft px-2.5 py-2">
      <div class="mb-0.5 text-2xs font-medium text-amber">{item.label}</div>
      <div class="whitespace-pre-wrap text-base text-muted">{item.text}</div>
    </div>
  {:else if item.kind === 'agent'}
    <div class="mb-3">
      {#if item.thinking}
        <!-- Reasoning, in full as text: muted, at the answer's size (see main.css),
             so it reads as the agent thinking aloud and the answer still outranks it. -->
        <div
          class="agent-markdown agent-thinking prose mb-1.5 max-w-none"
          use:floatingCodeScrollbars
          use:highlightCodeFences
          use:linkCodeReferences={{ root, onOpen: openReference }}
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(item.thinking)}
        </div>
      {/if}
      {#if item.text}
        <div
          class="agent-markdown agent-message prose max-w-none text-default"
          use:floatingCodeScrollbars
          use:highlightCodeFences
          use:linkCodeReferences={{ root, onOpen: openReference }}
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(item.text)}
        </div>
        <AgentMessageCards text={item.text} />
      {/if}
    </div>
  {:else if item.kind === 'tool'}
    {@render toolCall(item, live)}
  {:else if item.kind === 'shell'}
    <AgentShellRun {item} {sessionId} />
  {:else if item.kind === 'notice'}
    {@const refused = item.refusal ? refusedPrompt(header) : null}
    {@const toneClass =
      item.tone === 'error'
        ? 'border-red/30 bg-red-soft text-red'
        : 'border-line bg-elevated text-muted'}
    <div class="-mx-3 mb-3 flex items-center gap-2 border-y px-3 py-2 text-2xs {toneClass}">
      <span class="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
      {#if refused}
        <!-- A refused prompt stays in the conversation and gets everything after
             it refused too; rewording it in place is the way out short of a new
             session. -->
        <button
          class="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-default hover:bg-hover"
          onclick={() => startEdit(refused)}
        >
          <PencilSimple width="12" height="12" />
          Edit prompt
        </button>
      {/if}
    </div>
  {:else if item.kind === 'compaction'}
    <AgentCompaction {item} />
  {:else if item.kind === 'surface'}
    <AgentSurface node={item.view} surfaceId={item.surfaceId} {root} {onOpenLocation} />
  {/if}
{/snippet}

<FloatingScrollbar class="min-h-0 flex-1" bind:viewport {onscroll}>
  <div class="px-3 py-3 text-xs leading-relaxed">
    {#each sections as section (section.key)}
      <!-- The section box is the sticky header's containing block, so the pinned
           user bubble scrolls away with its own turn instead of stacking. -->
      {@const settled = section.settled}
      {@const rows = rowsOf(section, settled)}
      {@const fold = settled
        ? foldTurn(rows, standsAloneWhenFolded, partOfAnswer)
        : { hidden: [], kept: rows }}
      {@const open = Boolean(expandedTurns[section.key])}
      <div data-section={section.key}>
        {#if section.header}
          <div class="sticky top-0 z-10">
            {@render row(section.header, false)}
          </div>
        {/if}
        {#if fold.hidden.length > 0}
          {@render turnSummary(section.key, fold.hidden, open)}
          {@const files = open ? [] : changedFilesIn(fold.hidden)}
          {#if files.length > 0}
            {@render changedFiles(files)}
          {/if}
        {/if}
        {#each open ? toItemRows(bodyOf(section)) : fold.kept as bodyRow (bodyRow.key)}
          {#if bodyRow.kind === 'toolRun'}
            {@render toolRun(bodyRow)}
          {:else if bodyRow.kind === 'callGroup'}
            {@render callGroup(bodyRow)}
          {:else}
            {@render row(bodyRow.item, !settled, section.header)}
          {/if}
        {/each}
      </div>
    {/each}
    {#if items.length === 0 && !thinking}
      <p class="text-dim">Nothing yet. Write a prompt below.</p>
    {/if}
    {@render footer?.()}
  </div>
</FloatingScrollbar>
