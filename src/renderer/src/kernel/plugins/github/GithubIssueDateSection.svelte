<script lang="ts">
  // One of the organisation's date issue fields in the thread's sidebar, Start
  // date or Target date say: a date picker, and a way to clear it. The day is
  // written on Enter or when the picker loses focus, not on every change: typing
  // a date changes it once per part, and the first would already be sent.
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import { applyIssueDate, github } from './store.svelte'
  import type { GithubIssueDateField } from '../../../../../shared/types'

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

  function onKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit(event.currentTarget.value)
  }
</script>

<section class="flex flex-col gap-1.5">
  <h3 class="font-medium text-default">{field.name}</h3>
  <div class="flex items-center gap-1">
    <input
      type="date"
      class="min-w-0 flex-1 rounded-md border border-line bg-input px-1.5 py-0.5 text-2xs text-default outline-none focus:border-line-strong disabled:opacity-50"
      aria-label={field.name}
      value={pickerValue}
      onkeydown={onKey}
      onblur={(event) => commit(event.currentTarget.value)}
    />
    {#if date !== null}
      <button
        class="cursor-pointer rounded p-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
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
