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
  import { searchFiles, uploadBlob } from '../../../../lib/nib/api'
  import {
    activeCompletion,
    applyCompletion,
    parseSubmission,
    type Completion
  } from '../../../../lib/nib/completion'
  import type { ClientEventBody, ImageBlock, UserContentBlock } from '../../../../lib/nib/types'

  let {
    sessionId,
    running,
    commandNames,
    placeholderHint = '',
    onSend,
    onFocusChange
  }: {
    sessionId: string
    running: boolean
    commandNames: string[]
    placeholderHint?: string
    onSend: (events: ClientEventBody[]) => void
    onFocusChange: (focused: boolean) => void
  } = $props()

  let draft = $state('')
  let caret = $state(0)
  let promptEl = $state<HTMLTextAreaElement>()
  let focused = $state(false)
  let error = $state('')

  // Images pasted or dropped into the composer, already uploaded and waiting to
  // ride along with the next message.
  let attachments = $state<ImageBlock[]>([])

  // Sent messages, newest last, stepped through with the arrow keys.
  let history = $state<string[]>([])
  let historyIndex = $state(-1)

  const completion = $derived(activeCompletion(draft, caret))
  let suggestions = $state<string[]>([])
  let suggestionIndex = $state(0)
  let suggestionListEl = $state<HTMLDivElement>()

  const menuOpen = $derived(completion !== null && suggestions.length > 0)

  // Suggestions follow the caret. File matches come from the server, which knows
  // the workspace; commands are already in hand.
  $effect(() => {
    const active = completion
    if (!active) {
      suggestions = []
      return
    }
    if (active.kind === 'command') {
      suggestions = commandNames.filter((name) => name.startsWith(active.query)).slice(0, 20)
      suggestionIndex = 0
      return
    }
    void loadFileSuggestions(active)
  })

  async function loadFileSuggestions(active: Completion): Promise<void> {
    try {
      const response = await searchFiles(sessionId, active.query)
      // The caret may have moved on while the request was in flight.
      if (completion?.start !== active.start || completion?.query !== active.query) return
      suggestions = response.files.map((file) => file.path)
      suggestionIndex = 0
    } catch {
      suggestions = []
    }
  }

  function syncCaret(): void {
    caret = promptEl?.selectionStart ?? draft.length
  }

  function acceptSuggestion(value: string): void {
    if (!completion) return
    draft = applyCompletion(draft, completion, value)
    suggestions = []
    queueMicrotask(() => {
      promptEl?.focus()
      const end = draft.length
      promptEl?.setSelectionRange(end, end)
      syncCaret()
    })
  }

  function submit(): void {
    const submission = parseSubmission(draft)
    if (!submission && attachments.length === 0) return

    const events = eventsFor(submission)
    if (events.length === 0) return

    onSend(events)
    if (draft.trim().length > 0) history = [...history, draft]
    draft = ''
    attachments = []
    historyIndex = -1
    suggestions = []
  }

  /** A submitted draft, as the client events nib expects for it. */
  function eventsFor(submission: ReturnType<typeof parseSubmission>): ClientEventBody[] {
    if (!submission) {
      // Attachments with no text still count as something to say.
      if (attachments.length === 0) return []
      return [{ type: 'user.message', content: [...attachments], deliverAs: 'steer' }]
    }
    if (submission.kind === 'shell') {
      return [{ type: 'user.shell', command: submission.command, share: submission.share }]
    }
    if (submission.kind === 'command') {
      return [{ type: 'user.command', name: submission.name, args: submission.args }]
    }

    const content: UserContentBlock[] = [{ type: 'text', text: submission.text }, ...attachments]
    // While a turn is running, `steer` redirects the work in flight rather than
    // waiting for it to finish — which is what typing mid-run is usually for.
    return [{ type: 'user.message', content, deliverAs: 'steer' }]
  }

  function onKey(event: KeyboardEvent): void {
    if (menuOpen && handleMenuKey(event)) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
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
      acceptSuggestion(suggestions[suggestionIndex])
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      suggestions = []
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

<div class="relative">
  {#if menuOpen}
    <!-- Completions float above the composer. -->
    <div
      class="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
    >
      <FloatingScrollbar class="max-h-56" bind:viewport={suggestionListEl}>
        {#each suggestions as suggestion, index (suggestion)}
          <button
            class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs {index ===
            suggestionIndex
              ? 'bg-action text-action-fg'
              : 'text-muted hover:bg-hover'}"
            onmousedown={(event) => {
              event.preventDefault()
              acceptSuggestion(suggestion)
            }}
          >
            <span class="truncate font-mono">{suggestion}</span>
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

  <div class="relative mb-2 rounded-md border border-line-strong bg-elevated">
    <textarea
      bind:this={promptEl}
      bind:value={draft}
      class="h-20 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim"
      placeholder={running
        ? 'Steer the running agent…  ( Enter send · Ctrl+C interrupt )'
        : `Prompt…  ( / commands · @ files · ! shell · ↑↓ history · Enter send${placeholderHint} )`}
      onkeydown={onKey}
      onkeyup={syncCaret}
      onclick={syncCaret}
      oninput={syncCaret}
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
