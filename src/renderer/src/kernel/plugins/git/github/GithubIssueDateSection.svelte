<script lang="ts">
  // One of the organisation's date issue fields in the thread's sidebar, Start
  // date or Target date say: a date picker, and a way to clear it. The day is
  // written on Enter or when the picker loses focus, not on every change: typing
  // a date changes it once per part, and the first would already be sent.
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import { applyIssueDate, github } from './store.svelte'
  import type { GithubIssueDateField } from '../../../../../../shared/types'

  let {
    field,
    date
  }: {
    field: GithubIssueDateField
    /** The issue's day for this field, `YYYY-MM-DD`, or null when it is not set. */
    date: string | null
  } = $props()

  /** The picker's value: the day, or empty for none. */
  const pickerValue = $derived.by(() => {
    if (date === null) return ''
    return date
  })

  /** Writes the picker's day, or clears the field when the picker is emptied. */
  function commit(value: string): void {
    let next: string | null = value
    if (value === '') next = null
    if (next === date) return
    void applyIssueDate(field.id, next)
  }

  /** Opens the browser's date picker; its own calendar button is hidden to save the room. */
  function openPicker(event: MouseEvent & { currentTarget: HTMLInputElement }): void {
    try {
      event.currentTarget.showPicker()
    } catch {
      // Not allowed without a user gesture, or already open: typing still works.
    }
  }

  function onKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit(event.currentTarget.value)
  }
</script>

<!-- Half a row: the sidebar puts the date fields side by side, so the name is a
     small label, the browser's calendar button gives way to a click anywhere on
     the input, and the clear button takes its place. -->
<section class="flex min-w-0 flex-col gap-1">
  <h3 class="truncate text-2xs text-dim">{field.name}</h3>
  <div class="relative flex min-w-0">
    <input
      type="date"
      class="min-w-0 flex-1 cursor-pointer rounded-md border border-line bg-input px-2 py-1 text-xs text-default outline-none focus:border-line-strong disabled:opacity-50 [&::-webkit-calendar-picker-indicator]:hidden"
      class:pr-6={date !== null}
      aria-label={field.name}
      value={pickerValue}
      onclick={openPicker}
      onkeydown={onKey}
      onblur={(event) => commit(event.currentTarget.value)}
    />
    {#if date !== null}
      <button
        class="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
        title="Clear {field.name.toLowerCase()}"
        aria-label="Clear {field.name.toLowerCase()}"
        disabled={github.busy}
        onclick={() => void applyIssueDate(field.id, null)}
      >
        <XIcon size={10} />
      </button>
    {/if}
  </div>
</section>
