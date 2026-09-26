<script lang="ts">
  // A tool call that asks the user something, rendered as the question it is.
  //
  // The agent is parked on the call, so this takes the composer's place the same
  // way an approval does. Answering runs the call with the answers written into
  // its input, which is how the asking tool reports them back to the model.
  //
  // A call may carry several questions. They are one tab each rather than one
  // long column: the pane is narrow, and answering is easier one question at a
  // time than scrolling past the ones already dealt with.

  import Check from 'phosphor-svelte/lib/Check'
  import { answeredInput, type AgentQuestion } from '../../../../lib/agents/questions'

  let {
    questions,
    input,
    onAnswer,
    onDecline
  }: {
    questions: AgentQuestion[]
    input: unknown
    onAnswer: (answeredInput: unknown) => void
    onDecline: () => void
  } = $props()

  // Chosen labels per question, and whatever the user typed instead.
  let chosen = $state<Record<string, string[]>>({})
  let typed = $state<Record<string, string>>({})
  let activeIndex = $state(0)
  // The row the keyboard is on: an option, or — one past the last — the
  // "something else" box.
  let cursor = $state(0)
  let rootEl = $state<HTMLDivElement>()
  let otherEl = $state<HTMLInputElement>()

  const active = $derived(questions[Math.min(activeIndex, questions.length - 1)])
  const otherRow = $derived(active ? active.options.length : 0)

  // Take the keyboard as soon as the question is up: the agent is waiting on
  // it, and nothing else in the pane can be done until it is answered.
  $effect(() => {
    queueMicrotask(() => rootEl?.focus())
  })

  // A new question starts with the keyboard on its first option.
  $effect(() => {
    void activeIndex
    cursor = 0
  })
  const answeredCount = $derived(questions.filter((entry) => answersFor(entry).length > 0).length)
  const complete = $derived(answeredCount === questions.length)

  /** What this question is answered with: the picked options, else the typed text. */
  function answersFor(entry: AgentQuestion): string[] {
    const text = (typed[entry.question] ?? '').trim()
    if (text.length > 0) return [text]
    return chosen[entry.question] ?? []
  }

  function tabLabel(entry: AgentQuestion, index: number): string {
    if (entry.header.trim().length > 0) return entry.header
    return `Question ${index + 1}`
  }

  function isPicked(entry: AgentQuestion, label: string): boolean {
    return (chosen[entry.question] ?? []).includes(label)
  }

  function pick(entry: AgentQuestion, label: string): void {
    const current = chosen[entry.question] ?? []
    if (!entry.multiSelect) {
      chosen = { ...chosen, [entry.question]: [label] }
      // One pick answers the question, so move on to the next — but never past
      // the last one: sending stays the user's call.
      if (activeIndex < questions.length - 1) activeIndex += 1
      return
    }
    const next = current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label]
    chosen = { ...chosen, [entry.question]: next }
  }

  /** The preview of what is picked here, when the option shipped one. */
  function previewOf(entry: AgentQuestion): string | null {
    const [first] = answersFor(entry)
    if (!first) return null
    return entry.options.find((option) => option.label === first)?.preview ?? null
  }

  function goToFirstUnanswered(): void {
    const index = questions.findIndex((entry) => answersFor(entry).length === 0)
    if (index >= 0) activeIndex = index
  }

  function confirm(): void {
    if (!complete) {
      goToFirstUnanswered()
      return
    }
    const answers = new Map<string, string[]>()
    for (const entry of questions) answers.set(entry.question, answersFor(entry))
    onAnswer(answeredInput(input, answers))
  }

  /** Moves the keyboard between the options and the "something else" row, wrapping round. */
  function moveCursor(step: number): void {
    const rows = otherRow + 1
    cursor = (cursor + step + rows) % rows
    if (cursor === otherRow) queueMicrotask(() => otherEl?.focus())
  }

  /** Switches to the previous or next question, stopping at either end. */
  function moveQuestion(step: number): void {
    const next = activeIndex + step
    if (next < 0 || next >= questions.length) return
    activeIndex = next
  }

  /** A key that types a character, rather than moving, confirming or chording. */
  function isTyping(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  }

  /**
   * Enter on an option picks it, as a click would; with every question
   * answered it sends. Anywhere else it sends, or moves to the question still
   * missing, so the key does the obvious thing at every point.
   */
  function enter(): void {
    const option = active?.options[cursor]
    if (option && !active.multiSelect) {
      const wasLast = activeIndex === questions.length - 1
      pick(active, option.label)
      if (wasLast || complete) confirm()
      return
    }
    confirm()
  }

  function onKey(event: KeyboardEvent): void {
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDecline()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      enter()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault()
      moveCursor(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveCursor(-1)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveQuestion(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      const option = active.options[cursor]
      if (option) pick(active, option.label)
      return
    }
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= active.options.length) {
      event.preventDefault()
      cursor = digit - 1
      pick(active, active.options[cursor].label)
      return
    }
    // Typing anything else is an answer of the user's own.
    if (isTyping(event)) {
      event.preventDefault()
      typed = { ...typed, [active.question]: (typed[active.question] ?? '') + event.key }
      cursor = otherRow
      queueMicrotask(() => otherEl?.focus())
    }
  }

  /**
   * Keys inside the "something else" box: Enter sends, and Up or Escape go
   * back to the options, leaving whatever was typed.
   */
  function onOtherKey(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      confirm()
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'Escape') {
      event.preventDefault()
      cursor = Math.max(otherRow - 1, 0)
      rootEl?.focus()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      cursor = 0
      rootEl?.focus()
    }
  }
</script>

<div
  bind:this={rootEl}
  class="rounded-md border border-line bg-elevated p-3 outline-none"
  tabindex="-1"
  onkeydown={onKey}
  role="group"
>
  {#if questions.length > 1}
    <div class="no-scrollbar mb-2 flex items-center gap-1 overflow-x-auto">
      {#each questions as entry, index (entry.question)}
        {@const answered = answersFor(entry).length > 0}
        <button
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-2xs"
          class:bg-hover={index === activeIndex}
          class:text-default={index === activeIndex}
          class:text-dim={index !== activeIndex}
          onclick={() => (activeIndex = index)}
        >
          <span class="max-w-[9rem] truncate">{tabLabel(entry, index)}</span>
          {#if answered}
            <span class="text-green"><Check width="10" height="10" weight="bold" /></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if active}
    {#if questions.length === 1 && active.header}
      <span class="inline-block rounded border border-line px-1.5 py-0.5 text-2xs text-muted">
        {active.header}
      </span>
    {/if}
    {#if active.multiSelect}
      <span class="ml-1 text-2xs text-dim">pick any</span>
    {/if}

    <div class="mt-1.5 text-xs text-default">{active.question}</div>

    <!-- The keyboard's row is shaded and picked options carry a check; a
         pointer resting over the card by accident marks neither. -->
    <div class="mt-2 flex flex-col">
      {#each active.options as option, optionIndex (option.label)}
        <button
          class="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-xs outline-none"
          class:bg-hover={cursor === optionIndex}
          tabindex="-1"
          onclick={() => {
            cursor = optionIndex
            pick(active, option.label)
          }}
        >
          <span class="w-3 shrink-0 text-2xs text-dim">{optionIndex + 1}.</span>
          <span
            class="shrink-0 font-medium"
            class:text-default={isPicked(active, option.label) || cursor === optionIndex}
            class:text-muted={!isPicked(active, option.label) && cursor !== optionIndex}
          >
            {option.label}
          </span>
          <span class="min-w-0 flex-1 truncate text-dim">{option.description}</span>
          {#if isPicked(active, option.label)}
            <span class="shrink-0 self-center text-green">
              <Check width="11" height="11" weight="bold" />
            </span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- The tool promises the user an "other" that is never in the options. -->
    <input
      bind:this={otherEl}
      class="mt-1.5 w-full rounded-md border border-line bg-input px-2 py-1 text-xs"
      class:border-line-strong={cursor === otherRow}
      placeholder="Something else…"
      onfocus={() => (cursor = otherRow)}
      onkeydown={onOtherKey}
      bind:value={
        () => typed[active.question] ?? '',
        (value) => (typed = { ...typed, [active.question]: value })
      }
    />

    {#if previewOf(active)}
      <pre
        class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted">{previewOf(
          active
        )}</pre>
    {/if}
  {/if}

  <div class="mt-2 flex items-center gap-2 border-t border-line pt-2 text-2xs text-dim">
    <span class="min-w-0 flex-1 truncate">
      {#if questions.length > 1}
        {answeredCount}/{questions.length} answered · ↑↓ choose · ←→ question · Enter to pick
      {:else}
        ↑↓ to choose, Enter to pick, or type your own · Esc to skip
      {/if}
    </span>
    <button
      class="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover"
      onclick={onDecline}
    >
      Skip
    </button>
    <button
      class="shrink-0 rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-50"
      disabled={!complete}
      onclick={confirm}
    >
      Send
    </button>
  </div>
</div>
