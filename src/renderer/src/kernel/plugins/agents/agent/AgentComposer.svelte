<script lang="ts">
  // Writing to the agent.
  //
  // What a draft means is decided by `parseSubmission`: `/` runs a command, `!`
  // runs a shell command the model can see, `!!` keeps it to yourself, `//`
  // escapes a message that genuinely starts with a slash. Completion is derived
  // from the text and the caret rather than tracked as state, so it stays correct
  // through clicks, undo and paste.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import Kbd from '../../../../components/Kbd.svelte'
  import { completeShell, searchFiles, shellName, uploadBlob } from '../../../../lib/agents/api'
  import {
    activeCompletion,
    applyCompletion,
    draftSegments,
    parseSubmission,
    shellDraft,
    type Completion
  } from '../../../../lib/agents/completion'
  import { highlightCodeSync, warmLanguage } from '../../../../lib/highlight'
  import { selectionRef } from '../../../../lib/inlineEditRef'
  import { store } from '../../../../lib/store.svelte'
  import type {
    ClientEventBody,
    FileBlock,
    ImageBlock,
    UserContentBlock
  } from '../../../../lib/agents/types'

  let {
    sessionId,
    running,
    commandNames,
    history,
    placeholderHint = '',
    hidden = false,
    onKeystroke,
    onSend,
    onFocusChange,
    onInterrupt,
    onCycleMode,
    onBack
  }: {
    sessionId: string
    running: boolean
    commandNames: string[]
    /**
     * Everything already said in this session, oldest last. It comes from the
     * transcript rather than from what this composer has typed, so stepping back
     * through it reaches the whole conversation — including the part that
     * happened before the app was last restarted.
     */
    history: string[]
    placeholderHint?: string
    /**
     * Out of sight while an approval or question card stands in for it. Hidden
     * rather than unmounted, so the draft is still there once the card is answered.
     */
    hidden?: boolean
    /** Every key pressed in the draft, so the pane can tell when the user is mid-sentence. */
    onKeystroke?: () => void
    onSend: (events: ClientEventBody[]) => void
    onFocusChange: (focused: boolean) => void
    onInterrupt: () => void
    /**
     * Step the permission mode on. Handled here as well as in the pane's
     * bindings because shift+tab carries no ctrl/alt/meta, and the keymap leaves
     * unmodified keys to whatever is being typed in.
     */
    onCycleMode?: () => void
    /**
     * Step left out of the conversation, to the session overview. Only offered
     * from an empty draft, so ArrowLeft stays a cursor key while typing.
     */
    onBack?: () => void
  } = $props()

  let draft = $state('')
  let caret = $state(0)
  let promptEl = $state<HTMLTextAreaElement>()
  let focused = $state(false)
  let error = $state('')

  // Images pasted or dropped into the composer, already uploaded and waiting to
  // ride along with the next message.
  let attachments = $state<ImageBlock[]>([])

  // File slices sent over from the editor, riding along with the next message so
  // the model reads the code rather than resolving a path itself.
  let references = $state<FileBlock[]>([])

  // How far back through `history` the arrow keys have stepped; -1 is the draft
  // being written. Reset on a session change, since the history is another one's.
  let historyIndex = $state(-1)

  $effect(() => {
    sessionId
    historyIndex = -1
  })

  // Set by Tab in a shell draft, which asks for completions of a word not yet
  // started; cleared by the next edit.
  let completionRequested = $state(false)

  const completion = $derived(activeCompletion(draft, caret, completionRequested))

  interface Suggestion {
    value: string
    description?: string
  }

  let suggestions = $state<Suggestion[]>([])
  let suggestionIndex = $state(0)
  let suggestionListEl = $state<HTMLDivElement>()

  const menuOpen = $derived(completion !== null && suggestions.length > 0)

  // Suggestions follow the caret. File matches and shell completions come from
  // the main process, which knows the workspace; commands are already in hand.
  $effect(() => {
    const active = completion
    if (!active) {
      suggestions = []
      return
    }
    if (active.kind === 'command') {
      suggestions = commandNames
        .filter((name) => name.startsWith(active.query))
        .slice(0, 20)
        .map((name) => ({ value: name }))
      suggestionIndex = 0
      return
    }
    void loadRemoteSuggestions(active)
  })

  /** Fetches suggestions for a completion that needs the main process to answer. */
  async function loadRemoteSuggestions(active: Completion): Promise<void> {
    try {
      const values = await fetchSuggestions(active)
      // The caret may have moved on while the request was in flight.
      if (completion?.start !== active.start || completion?.query !== active.query) return
      suggestions = values
      suggestionIndex = 0
      // Like a shell's Tab: a single answer to an explicit request is just taken.
      if (completionRequested && values.length === 1) {
        acceptSuggestion(values[0].value)
      }
    } catch {
      suggestions = []
    }
  }

  /** Asks the main process for `@` file matches or the shell's completions of a `!` word. */
  async function fetchSuggestions(active: Completion): Promise<Suggestion[]> {
    if (active.kind === 'shell') {
      return completeShell(sessionId, active.line ?? '')
    }
    const matches = await searchFiles(sessionId, active.query)
    return matches.map((match) => ({ value: match.path }))
  }

  function syncCaret(): void {
    caret = promptEl?.selectionStart ?? draft.length
    syncHighlightScroll()
  }

  // The highlight layer is a second copy of the text with the same typography, so
  // it only stays in register while it scrolls with the textarea over it.
  let highlightEl = $state<HTMLDivElement>()

  function syncHighlightScroll(): void {
    if (!highlightEl || !promptEl) {
      return
    }
    highlightEl.scrollTop = promptEl.scrollTop
    highlightEl.scrollLeft = promptEl.scrollLeft
  }

  const segments = $derived(draftSegments(draft))

  // A `!` draft is not a message but a command about to run in grove's shell, so
  // the layer paints it as shell rather than as prose: the marker as a marker,
  // the rest tokenized with the same grammar the transcript shows commands in.
  const shell = $derived(shellDraft(draft))

  // `!!` keeps the output to yourself, `!` shows it to the model.
  const shellBadge = $derived.by(() => {
    if (shell?.marker === '!!') {
      return { label: 'shell · private', title: 'Runs in the worktree; the output stays with you' }
    }
    return { label: 'shell · shared', title: 'Runs in the worktree; the agent sees the output' }
  })

  // The grammar of the shell `!` commands run in — fish's when that is the
  // user's shell, bash's otherwise — loaded once, up front. Tokenizing per
  // keystroke has to land in the same frame as the character that caused it:
  // awaiting a promise for each one paints the draft plain and then colours it,
  // which is the flash.
  let shellLanguage = $state('bash')
  let shellGrammarReady = $state(false)

  $effect(() => {
    void loadShellGrammar()
  })

  /** Picks the grammar for the user's shell and loads it. */
  async function loadShellGrammar(): Promise<void> {
    const name = await shellName().catch(() => 'bash')
    if (name === 'fish') {
      shellLanguage = 'fish'
    }
    shellGrammarReady = await warmLanguage(shellLanguage)
  }

  /** The coloured runs for the command being typed; empty until the grammar is in. */
  const shellLines = $derived.by(() => {
    if (!shell || !shellGrammarReady) return []
    const lines = highlightCodeSync(shell.command, shellLanguage, store.activeTheme.scheme)
    if (!lines) return []
    return lines
  })

  /**
   * Drop an `@ref ` into the draft where the caret is, and leave the caret and
   * focus after it.
   *
   * Revealing the pane focuses it on the next animation frame, so the focus here
   * has to be taken on a frame rather than a microtask — otherwise the pane
   * takes it back and the reference lands in a composer nobody is typing in.
   */
  function insertMentionAtCaret(reference: string): void {
    const at = promptEl ? promptEl.selectionStart : draft.length
    const mention = `@${reference} `
    draft = draft.slice(0, at) + mention + draft.slice(at)
    requestAnimationFrame(() => {
      if (!promptEl) return
      const position = at + mention.length
      promptEl.focus()
      promptEl.setSelectionRange(position, position)
      syncCaret()
    })
  }

  // Hiding a focused textarea doesn't reliably fire `blur`, which would leave the
  // pane in insert mode with nothing visible to type into.
  $effect(() => {
    if (hidden) promptEl?.blur()
  })

  // An @file:lines reference pushed in from the editor selection ("Send
  // Selection to Composer"). Taken off the store as it lands, so a composer
  // mounted later (another session, another pane) doesn't insert it again.
  $effect(() => {
    const request = store.composerInsert
    if (!request) return
    store.composerInsert = null
    insertMentionAtCaret(request.text)
    if (request.reference) attachReference(request.reference)
  })

  /** Carry a file slice with the next message, replacing an identical earlier one. */
  function attachReference(reference: FileBlock): void {
    const kept = references.filter((existing) => mentionFor(existing) !== mentionFor(reference))
    references = [...kept, reference]
  }

  /** The `@file:lines` text a slice rides along with. */
  function mentionFor(reference: FileBlock): string {
    return `@${selectionRef(reference.path, reference.startLine, reference.endLine)}`
  }

  /**
   * The slices still spoken for by the draft. The mention is the only handle on
   * an attached selection, so deleting it from the text is what detaches it.
   */
  function activeReferences(): FileBlock[] {
    return references.filter((reference) => draft.includes(mentionFor(reference)))
  }

  /** Writes a suggestion into the draft and leaves the caret just after it. */
  function acceptSuggestion(value: string): void {
    if (!completion) return
    const next = applyCompletion(draft, completion, value)
    const caretAfter = completion.end + next.length - draft.length
    draft = next
    suggestions = []
    completionRequested = false
    queueMicrotask(() => {
      promptEl?.focus()
      promptEl?.setSelectionRange(caretAfter, caretAfter)
      syncCaret()
    })
  }

  function submit(): void {
    const submission = parseSubmission(draft)
    const carried = carriedBlocks()
    if (!submission && carried.length === 0) return

    const events = eventsFor(submission, carried)
    if (events.length === 0) return

    onSend(events)
    draft = ''
    attachments = []
    references = []
    historyIndex = -1
    suggestions = []
  }

  /** Everything riding along with the message: attached slices, then images. */
  function carriedBlocks(): UserContentBlock[] {
    return [...activeReferences(), ...attachments]
  }

  /** A submitted draft, as the client events a session expects for it. */
  function eventsFor(
    submission: ReturnType<typeof parseSubmission>,
    carried: UserContentBlock[]
  ): ClientEventBody[] {
    if (!submission) {
      // Attachments with no text still count as something to say.
      if (carried.length === 0) return []
      return [{ type: 'user.message', content: carried, deliverAs: 'steer' }]
    }
    if (submission.kind === 'shell') {
      return [{ type: 'user.shell', command: submission.command, share: submission.share }]
    }
    if (submission.kind === 'command') {
      return [{ type: 'user.command', name: submission.name, args: submission.args }]
    }

    const content: UserContentBlock[] = [{ type: 'text', text: submission.text }, ...carried]
    // While a turn is running, `steer` redirects the work in flight rather than
    // waiting for it to finish — which is what typing mid-run is usually for.
    return [{ type: 'user.message', content, deliverAs: 'steer' }]
  }

  function onKey(event: KeyboardEvent): void {
    onKeystroke?.()
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      onCycleMode?.()
      return
    }
    if (menuOpen && handleMenuKey(event)) return

    // Tab in a shell draft asks the shell what could come next.
    if (event.key === 'Tab' && shell) {
      event.preventDefault()
      completionRequested = true
      return
    }

    // Escape stops the turn in flight without leaving the composer, so the draft
    // being typed survives the interrupt.
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      onInterrupt()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'ArrowLeft' && draft.length === 0 && onBack) {
      event.preventDefault()
      onBack()
      return
    }
    if (event.key === 'ArrowUp' && draft.length === 0 && history.length > 0) {
      event.preventDefault()
      stepHistory(-1)
      return
    }
    if (event.key === 'ArrowUp' && historyIndex >= 0) {
      event.preventDefault()
      stepHistory(-1)
      return
    }
    if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault()
      stepHistory(1)
    }
  }

  function handleMenuKey(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      suggestionIndex = (suggestionIndex + 1) % suggestions.length
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      suggestionIndex = (suggestionIndex - 1 + suggestions.length) % suggestions.length
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      acceptSuggestion(suggestions[suggestionIndex].value)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      suggestions = []
      completionRequested = false
      return true
    }
    return false
  }

  function stepHistory(direction: number): void {
    const next = historyIndex === -1 ? history.length - 1 : historyIndex + direction
    if (next < 0 || next >= history.length) {
      historyIndex = -1
      draft = ''
      return
    }
    historyIndex = next
    draft = history[next]
  }

  // ── Attachments ─────────────────────────────────────────────────

  async function attach(files: File[]): Promise<void> {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      try {
        const blob = await uploadBlob(sessionId, file)
        attachments = [...attachments, { type: 'image', ref: blob.ref, mediaType: blob.mediaType }]
        error = ''
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
  }

  function onPaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void attach(files)
  }

  function onDrop(event: DragEvent): void {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void attach(files)
  }

  export function focus(): void {
    promptEl?.focus()
  }
</script>

<div class="relative" {hidden}>
  {#if menuOpen}
    <!-- Completions float above the composer. -->
    <div
      class="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
    >
      <FloatingScrollbar class="max-h-56" bind:viewport={suggestionListEl}>
        {#each suggestions as suggestion, index (suggestion.value)}
          <button
            class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs {index ===
            suggestionIndex
              ? 'bg-action text-action-fg'
              : 'text-muted hover:bg-hover'}"
            onmousedown={(event) => {
              event.preventDefault()
              acceptSuggestion(suggestion.value)
            }}
          >
            <span class="shrink-0 truncate font-mono">{suggestion.value}</span>
            {#if suggestion.description}
              <span
                class="ml-auto min-w-0 truncate pl-3 text-2xs"
                class:text-dim={index !== suggestionIndex}
              >
                {suggestion.description}
              </span>
            {/if}
          </button>
        {/each}
      </FloatingScrollbar>
    </div>
  {/if}

  {#if attachments.length > 0}
    <div class="mb-1.5 flex flex-wrap gap-1.5">
      {#each attachments as attachment, index (attachment.ref)}
        <button
          class="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-2xs text-muted hover:text-red"
          title="Remove attachment"
          onclick={() => (attachments = attachments.filter((_, at) => at !== index))}
        >
          image ✕
        </button>
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="mb-1.5 truncate text-2xs text-red">{error}</div>
  {/if}

  <!-- A `!` draft switches the box to shell: monospace in a heavier weight, and an
       amber frame that says whether the model will see the output. Both copies of
       the text take the same font classes so they stay in register. -->
  <div
    class="relative mb-2 rounded-md border bg-elevated"
    class:border-line-strong={!shell}
    class:border-amber={shell !== null}
  >
    <textarea
      bind:this={promptEl}
      bind:value={draft}
      class="relative z-0 block h-20 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-xs leading-normal text-transparent caret-default outline-none placeholder:text-dim"
      class:font-mono={shell !== null}
      class:font-medium={shell !== null}
      spellcheck={shell === null}
      placeholder={running
        ? 'Steer the running agent…  ( Enter send · Esc interrupt )'
        : `Prompt…  ( / commands · @ files · ! shell · ↑↓ history · ← sessions · Enter send${placeholderHint} )`}
      onkeydown={onKey}
      onkeyup={syncCaret}
      onclick={syncCaret}
      oninput={() => {
        completionRequested = false
        syncCaret()
      }}
      onscroll={syncHighlightScroll}
      onpaste={onPaste}
      ondrop={onDrop}
      ondragover={(event) => event.preventDefault()}
      onfocus={() => {
        focused = true
        onFocusChange(true)
      }}
      onblur={() => {
        focused = false
        onFocusChange(false)
      }}
    ></textarea>

    <!-- The text again, painted over the (transparent) textarea so `@file`
         mentions read as one token and a `!` command reads as shell. Everything
         that decides layout — padding, size, leading, wrapping — has to match the
         textarea exactly, or the two copies drift apart as the draft grows. The
         zero-width space keeps a draft ending in a newline the same height in
         both. -->
    <div
      bind:this={highlightEl}
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-10 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 text-xs leading-normal text-default"
      class:font-mono={shell !== null}
      class:font-medium={shell !== null}
    >
      {#if shell}{shell.lead}<span class="rounded-sm bg-amber-soft text-amber">{shell.marker}</span
        >{#each shellLines as line, lineIndex (lineIndex)}{#if lineIndex > 0}{'\n'}{/if}{#each line as token, tokenIndex (tokenIndex)}<span
              style:color={token.color}>{token.text}</span
            >{/each}{:else}{shell.command}{/each}{:else}{#each segments as segment, index (index)}{#if segment.mention}<span
              class="rounded-sm bg-action/15 text-action">{segment.text}</span
            >{:else}{segment.text}{/if}{/each}{/if}&#8203;
    </div>

    {#if shell}
      <span
        class="pointer-events-none absolute bottom-1 right-2 z-20 font-mono text-2xs text-amber"
        title={shellBadge.title}
      >
        {shellBadge.label}
      </span>
    {/if}

    {#if !focused}
      <!-- Normal-mode hint: press i (or click) to focus the composer. -->
      <button
        class="absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5 text-2xs text-dim transition hover:text-default"
        title="Focus composer"
        onclick={() => promptEl?.focus()}
      >
        <Kbd>i</Kbd>
        <span>to focus</span>
      </button>
    {/if}
  </div>
</div>
