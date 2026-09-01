<script lang="ts">
  // A tool call that asks the user something, rendered as the question it is.
  //
  // The agent is parked on the call, so this takes the composer's place the same
  // way an approval does. Answering runs the call with the answers written into
  // its input, which is how the asking tool reports them back to the model.

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

  const complete = $derived(questions.every((entry) => answersFor(entry).length > 0))

  /** What this question is answered with: the picked options, else the typed text. */
  function answersFor(entry: AgentQuestion): string[] {
    const text = (typed[entry.question] ?? '').trim()
    if (text.length > 0) return [text]
    return chosen[entry.question] ?? []
  }

  function isPicked(entry: AgentQuestion, label: string): boolean {
    return (chosen[entry.question] ?? []).includes(label)
  }

  function pick(entry: AgentQuestion, label: string): void {
    const current = chosen[entry.question] ?? []
    if (!entry.multiSelect) {
      chosen = { ...chosen, [entry.question]: [label] }
      return
    }
    const next = current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label]
    chosen = { ...chosen, [entry.question]: next }
  }

  function confirm(): void {
    if (!complete) return
    const answers = new Map<string, string[]>()
    for (const entry of questions) answers.set(entry.question, answersFor(entry))
    onAnswer(answeredInput(input, answers))
  }

  // Enter confirms from anywhere in the card; a textarea-free card means no key
  // is being stolen from an editor.
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    confirm()
  }
</script>

<div class="rounded-md border border-line bg-elevated p-3" onkeydown={onKey} role="group">
  {#each questions as entry (entry.question)}
    <div class="mb-3 last:mb-0">
      <div class="flex items-center gap-2">
        {#if entry.header}
          <span class="shrink-0 rounded border border-line px-1.5 py-0.5 text-2xs text-muted">
            {entry.header}
          </span>
        {/if}
        {#if entry.multiSelect}
          <span class="shrink-0 text-2xs text-dim">pick any</span>
        {/if}
      </div>
      <div class="mt-1.5 text-xs text-default">{entry.question}</div>

      <div class="mt-2 flex flex-col">
        {#each entry.options as option, optionIndex (option.label)}
          <button
            class="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover"
            class:bg-hover={isPicked(entry, option.label)}
            onclick={() => pick(entry, option.label)}
          >
            <span class="w-3 shrink-0 text-2xs text-dim">{optionIndex + 1}.</span>
            <span
              class="shrink-0 font-medium"
              class:text-default={isPicked(entry, option.label)}
              class:text-muted={!isPicked(entry, option.label)}
            >
              {option.label}
            </span>
            <span class="min-w-0 truncate text-dim">{option.description}</span>
          </button>
        {/each}
      </div>

      <!-- The tool promises the user an "other" that is never in the options. -->
      <input
        class="mt-1.5 w-full rounded-md border border-line bg-input px-2 py-1 text-xs"
        placeholder="Something else…"
        bind:value={
          () => typed[entry.question] ?? '',
          (value) => (typed = { ...typed, [entry.question]: value })
        }
      />

      {#if entry.options.some((option) => option.preview) && answersFor(entry).length > 0}
        {@const picked = entry.options.find((option) => option.label === answersFor(entry)[0])}
        {#if picked?.preview}
          <pre
            class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line px-2 py-1 font-mono text-2xs text-muted">{picked.preview}</pre>
        {/if}
      {/if}
    </div>
  {/each}

  <div class="mt-2 flex items-center gap-2 border-t border-line pt-2 text-2xs text-dim">
    <span class="min-w-0 flex-1 truncate">Pick an answer, or type your own. Enter to send.</span>
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
