<script lang="ts">
  import { buildAnswerResult, type DialogQuestion } from '../../lib/agentDialog'

  let {
    questions,
    onAnswer,
    onCancel
  }: {
    questions: DialogQuestion[]
    onAnswer: (result: ReturnType<typeof buildAnswerResult>) => void
    onCancel: () => void
  } = $props()

  let selections = $state<string[][]>(questions.map(() => []))
  let notes = $state('')
  let notesOpen = $state(false)
  let notesEl = $state<HTMLTextAreaElement>()

  // Ready when every question has a pick, or the user wrote free-form notes.
  const ready = $derived(
    questions.length > 0 &&
      (notes.trim().length > 0 ||
        questions.every((_question, index) => (selections[index]?.length || 0) > 0))
  )

  function openNotes(): void {
    notesOpen = true
    queueMicrotask(() => notesEl?.focus())
  }

  // Press "n" in the chooser to jot free-form notes (unless already typing).
  function onKey(event: KeyboardEvent): void {
    const tag = (event.target as HTMLElement)?.tagName
    if (event.key === 'n' && !notesOpen && tag !== 'TEXTAREA' && tag !== 'INPUT') {
      event.preventDefault()
      openNotes()
    }
  }

  function toggleOption(questionIndex: number, label: string, multiSelect: boolean): void {
    const current = selections[questionIndex] || []
    let next: string[]
    if (multiSelect) {
      next = current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label]
    } else {
      next = [label]
    }
    selections = selections.map((selection, index) => (index === questionIndex ? next : selection))
  }

  function submit(): void {
    onAnswer(buildAnswerResult(questions, selections, notes))
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="-mx-3 border-y border-green/40 bg-green-soft p-2" tabindex="-1" onkeydown={onKey}>
  {#each questions as question, questionIndex (questionIndex)}
    <div class="mb-3 last:mb-1">
      {#if question.header}
        <div
          class="mb-0.5 flex items-center gap-2 text-2xs font-semibold uppercase tracking-caps text-green"
        >
          <span>{question.header}</span>
          {#if question.multiSelect}<span class="normal-case tracking-normal text-dim"
              >· multi-select</span
            >{/if}
        </div>
      {/if}
      <div class="mb-1.5 text-xs text-default">{question.question}</div>
      <div class="flex flex-col gap-1">
        {#each question.options as option (option.label)}
          {@const selected = (selections[questionIndex] || []).includes(option.label)}
          <button
            class="rounded-md border px-2 py-1.5 text-left text-xs {selected
              ? 'border-green bg-green/15 text-default'
              : 'border-line text-muted hover:bg-hover'}"
            onclick={() => toggleOption(questionIndex, option.label, question.multiSelect)}
          >
            <span class="font-medium">{option.label}</span>
            {#if option.description}
              <span class="block text-2xs text-dim">{option.description}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/each}

  {#if notesOpen}
    <textarea
      bind:this={notesEl}
      bind:value={notes}
      class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
      placeholder="Notes / free-form answer…"
    ></textarea>
  {/if}

  <div class="flex items-center gap-2">
    <button
      class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-40"
      disabled={!ready}
      onclick={submit}
    >
      Answer
    </button>
    {#if !notesOpen}
      <button
        class="rounded-md border border-line px-3 py-1 text-xs text-dim hover:bg-hover"
        title="Add free-form notes"
        onclick={openNotes}
      >
        Notes (n)
      </button>
    {/if}
    <button
      class="ml-auto rounded-md border border-line px-3 py-1 text-xs text-dim hover:bg-hover"
      onclick={onCancel}
    >
      Cancel
    </button>
  </div>
</div>
