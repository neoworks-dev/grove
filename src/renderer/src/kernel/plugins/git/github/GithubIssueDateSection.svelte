<script lang="ts">
  // One of the organisation's date issue fields, Start date or Target date say,
  // as a short day on the sidebar's Dates row. Clicking it opens the browser's
  // date picker on a date input kept invisible under it; picking a day writes
  // it, and the cross beside a set day clears it.
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

  let picker = $state<HTMLInputElement | null>(null)

  /** The picker's value: the day, or empty for none. */
  const pickerValue = $derived.by(() => {
    if (date === null) return ''
    return date
  })

  /** The day as the row shows it: "Oct 20", with the year only when it is not this one. */
  const shown = $derived.by<string | null>(() => {
    if (date === null) return null
    const day = new Date(`${date}T00:00:00`)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    if (day.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'
    return day.toLocaleDateString(undefined, options)
  })

  /** Writes the picked day, or clears the field when the picker is emptied. */
  function commit(value: string): void {
    let next: string | null = value
    if (value === '') next = null
    if (next === date) return
    void applyIssueDate(field.id, next)
  }

  /** Opens the browser's date picker under the day. */
  function openPicker(): void {
    if (!picker) return
    try {
      picker.showPicker()
    } catch {
      // Already open, or refused without a user gesture: nothing to do.
    }
  }
</script>

<span class="group/date relative inline-flex min-w-0 items-center">
  <button
    class="truncate rounded px-1 py-0.5 hover:bg-hover disabled:opacity-50"
    class:text-default={shown !== null}
    class:text-faint={shown === null}
    title={field.name}
    aria-label="{field.name}: {shown === null ? 'not set' : shown}"
    disabled={github.busy}
    onclick={openPicker}
  >
    {#if shown === null}
      {field.name}
    {:else}
      {shown}
    {/if}
  </button>
  <input
    bind:this={picker}
    type="date"
    class="pointer-events-none absolute inset-0 opacity-0"
    tabindex="-1"
    aria-hidden="true"
    value={pickerValue}
    onchange={(event) => commit(event.currentTarget.value)}
  />
  {#if date !== null}
    <button
      class="hidden rounded p-0.5 text-dim hover:bg-hover hover:text-default group-hover/date:block disabled:opacity-50"
      title="Clear {field.name.toLowerCase()}"
      aria-label="Clear {field.name.toLowerCase()}"
      disabled={github.busy}
      onclick={() => void applyIssueDate(field.id, null)}
    >
      <XIcon size={9} />
    </button>
  {/if}
</span>
