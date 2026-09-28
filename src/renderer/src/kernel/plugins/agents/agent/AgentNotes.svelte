<script lang="ts">
  // The notes list above the composer: what is still to do, kept by the user and
  // the agent alike, with the plan the harness keeps for itself underneath.
  //
  // Notes are the session's own and anyone may tick one off; the plan belongs
  // to the harness, so it is shown as it reports it and nothing here changes it.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import CircleHalfIcon from 'phosphor-svelte/lib/CircleHalfIcon'
  import CircleIcon from 'phosphor-svelte/lib/CircleIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import RobotIcon from 'phosphor-svelte/lib/RobotIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import type { AgentTask, SessionNote } from '../../../../lib/agents/types'

  let {
    notes,
    tasks,
    onSave
  }: {
    notes: SessionNote[]
    tasks: AgentTask[]
    onSave: (notes: SessionNote[]) => void
  } = $props()

  let open = $state(true)
  let adding = $state(false)
  let draft = $state('')
  let editingId = $state<string | null>(null)
  let editDraft = $state('')

  const notesDone = $derived(notes.filter((note) => note.done).length)
  const tasksDone = $derived(tasks.filter((task) => task.status === 'completed').length)
  const empty = $derived(notes.length === 0 && tasks.length === 0)

  /** Plain copies: the list is saved over IPC, which a $state proxy cannot cross. */
  function plain(list: SessionNote[]): SessionNote[] {
    return list.map((note) => ({
      id: note.id,
      text: note.text,
      done: note.done,
      author: note.author
    }))
  }

  function startAdding(): void {
    open = true
    adding = true
  }

  function addDraft(): void {
    const text = draft.trim()
    if (text.length === 0) return
    const note: SessionNote = {
      id: crypto.randomUUID().slice(0, 8),
      text,
      done: false,
      author: 'user'
    }
    onSave([...plain(notes), note])
    draft = ''
  }

  function onDraftKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      addDraft()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      draft = ''
      adding = false
    }
  }

  function toggle(id: string): void {
    const next = plain(notes).map((note) => {
      if (note.id !== id) return note
      return { ...note, done: !note.done }
    })
    onSave(next)
  }

  function remove(id: string): void {
    onSave(plain(notes).filter((note) => note.id !== id))
  }

  function startEditing(note: SessionNote): void {
    editingId = note.id
    editDraft = note.text
  }

  function finishEditing(): void {
    const id = editingId
    editingId = null
    const text = editDraft.trim()
    if (!id || text.length === 0) return
    const next = plain(notes).map((note) => {
      if (note.id !== id) return note
      return { ...note, text }
    })
    onSave(next)
  }

  function onEditKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      finishEditing()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      editingId = null
    }
  }

  /** Puts the caret in an input as it appears. */
  function focusOnMount(element: HTMLInputElement): void {
    element.focus()
  }
</script>

<!-- The top of the composer: square below, where the prompt box carries on. -->
<div
  class="rounded-t-md border border-b-0 border-line-strong bg-elevated text-2xs"
  data-testid="agent-notes"
>
  <div class="flex items-center gap-1 px-1 py-0.5">
    <button
      class="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 text-left text-dim hover:text-default"
      aria-expanded={open}
      aria-label="Notes"
      disabled={empty}
      onclick={() => (open = !open)}
    >
      {#if !empty}
        <span class="flex transition-transform" class:rotate-90={open}>
          <CaretRightIcon size={10} />
        </span>
      {/if}
      {#if notes.length > 0}
        <span>{notesDone}/{notes.length}</span>
      {/if}
      {#if tasks.length > 0}
        {#if notes.length > 0}<span>·</span>{/if}
        <span>Plan {tasksDone}/{tasks.length}</span>
      {/if}
    </button>
    <button
      class="flex size-4 shrink-0 items-center justify-center rounded text-dim hover:bg-hover hover:text-default"
      title="Add a note"
      aria-label="Add a note"
      onclick={startAdding}
    >
      <PlusIcon size={12} />
    </button>
  </div>

  {#if open && !empty}
    <ul class="max-h-40 overflow-auto px-1 pb-0.5">
      {#each notes as note (note.id)}
        <li class="group/row flex items-center gap-1.5 rounded px-0.5 py-0.5 hover:bg-hover">
          <Checkbox
            size="sm"
            checked={note.done}
            onchange={() => toggle(note.id)}
            aria-label="Done: {note.text}"
          />
          {#if editingId === note.id}
            <input
              class="min-w-0 flex-1 rounded border border-line bg-input px-1 text-default outline-none"
              bind:value={editDraft}
              onkeydown={onEditKey}
              onblur={finishEditing}
              use:focusOnMount
            />
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class="min-w-0 flex-1 truncate"
              class:text-default={!note.done}
              class:text-dim={note.done}
              class:line-through={note.done}
              title={note.text}
              ondblclick={() => startEditing(note)}
            >
              {note.text}
            </span>
          {/if}
          {#if note.author === 'agent'}
            <span class="shrink-0 text-dim" title="Pinned by the agent">
              <RobotIcon size={11} />
            </span>
          {/if}
          <button
            class="hidden shrink-0 text-dim hover:text-red group-hover/row:block"
            title="Remove note"
            aria-label="Remove note"
            onclick={() => remove(note.id)}
          >
            <XIcon size={11} />
          </button>
        </li>
      {/each}

      {#if tasks.length > 0}
        {#if notes.length > 0}
          <li class="mx-0.5 my-1 border-t border-line"></li>
        {/if}
        {#each tasks as task (task.id)}
          <li class="flex items-center gap-1.5 px-0.5 py-0.5" title={task.text}>
            <span
              class="flex size-3.5 shrink-0 items-center justify-center"
              class:text-green={task.status === 'completed'}
              class:text-blue={task.status === 'in_progress'}
              class:text-dim={task.status === 'pending'}
            >
              {#if task.status === 'completed'}
                <CheckCircleIcon size={13} weight="fill" />
              {:else if task.status === 'in_progress'}
                <CircleHalfIcon size={13} weight="fill" />
              {:else}
                <CircleIcon size={13} />
              {/if}
            </span>
            <span
              class="min-w-0 flex-1 truncate"
              class:text-default={task.status === 'in_progress'}
              class:text-muted={task.status === 'pending'}
              class:text-dim={task.status === 'completed'}
              class:line-through={task.status === 'completed'}
            >
              {task.text}
            </span>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}

  {#if adding}
    <div class="px-1 pb-1">
      <input
        class="w-full rounded border border-line bg-input px-1.5 py-0.5 text-default outline-none placeholder:text-dim focus:border-line-strong"
        placeholder="Add a note — Enter to pin, Esc to close"
        bind:value={draft}
        onkeydown={onDraftKey}
        onblur={() => {
          if (draft.trim().length === 0) adding = false
        }}
        use:focusOnMount
      />
    </div>
  {/if}
</div>
