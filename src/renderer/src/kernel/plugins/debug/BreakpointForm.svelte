<script lang="ts">
  // The three things a breakpoint can carry besides its line: a condition it
  // only stops under, a hit count it waits for, and a message that turns it
  // into a logpoint. Shared by the box over the editor's gutter and the row in
  // the Run and Debug view. Enter saves from any field, Escape cancels; an
  // emptied field clears that option.
  import { untrack } from 'svelte'
  import Button from '@neoworks-dev/ui/Button'
  import type { DebugBreakpointOptions } from '../../../../../shared/debug'

  let {
    initial,
    autofocus = false,
    removable = false,
    stacked = false,
    onsave,
    oncancel,
    onremove
  }: {
    initial: DebugBreakpointOptions
    /** Focus the condition field as the form appears. */
    autofocus?: boolean
    /** Offer to remove the breakpoint, when there is one to remove. */
    removable?: boolean
    /** Labels above the fields rather than beside them, for a narrow sidebar. */
    stacked?: boolean
    onsave: (options: DebugBreakpointOptions) => void
    oncancel: () => void
    onremove?: () => void
  } = $props()

  // The fields start from the breakpoint as it was when the form opened; a
  // snapshot arriving while typing must not overwrite what is being typed.
  let condition = $state(untrack(() => initial.condition) || '')
  let hitCondition = $state(untrack(() => initial.hitCondition) || '')
  let logMessage = $state(untrack(() => initial.logMessage) || '')
  let firstField = $state<HTMLInputElement>()

  $effect(() => {
    if (autofocus) {
      queueMicrotask(() => firstField?.focus())
    }
  })

  /** Hands back every field, trimmed: an empty string clears that option. */
  function save(): void {
    onsave({
      condition: condition.trim(),
      hitCondition: hitCondition.trim(),
      logMessage: logMessage.trim()
    })
  }

  /** Enter saves and Escape cancels, without the editor's keymap seeing either. */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      save()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      oncancel()
    }
  }
</script>

<div class="flex flex-col gap-1 text-2xs">
  <label class="flex gap-x-2 gap-y-0.5" class:flex-col={stacked} class:items-center={!stacked}>
    <span class="w-20 shrink-0 whitespace-nowrap text-dim">Condition</span>
    <input
      bind:this={firstField}
      bind:value={condition}
      {onkeydown}
      class="min-w-0 flex-1 rounded border border-line bg-input px-1.5 py-0.5 font-mono text-default outline-none focus:border-line-strong"
      placeholder="Stop when this is true, e.g. count > 3"
      spellcheck="false"
    />
  </label>
  <label class="flex gap-x-2 gap-y-0.5" class:flex-col={stacked} class:items-center={!stacked}>
    <span class="w-20 shrink-0 whitespace-nowrap text-dim">Hit count</span>
    <input
      bind:value={hitCondition}
      {onkeydown}
      class="min-w-0 flex-1 rounded border border-line bg-input px-1.5 py-0.5 font-mono text-default outline-none focus:border-line-strong"
      placeholder="Stop on this hit, e.g. 5 or >= 10"
      spellcheck="false"
    />
  </label>
  <label class="flex gap-x-2 gap-y-0.5" class:flex-col={stacked} class:items-center={!stacked}>
    <span class="w-20 shrink-0 whitespace-nowrap text-dim">Log message</span>
    <input
      bind:value={logMessage}
      {onkeydown}
      class="min-w-0 flex-1 rounded border border-line bg-input px-1.5 py-0.5 font-mono text-default outline-none focus:border-line-strong"
      placeholder="Log instead of stopping: x is {'{x}'}"
      spellcheck="false"
    />
  </label>
  <div class="mt-0.5 flex items-center gap-1">
    {#if removable && onremove}
      <Button size="sm" variant="ghost" onclick={onremove}>Remove</Button>
    {/if}
    <span class="flex-1"></span>
    <Button size="sm" variant="ghost" onclick={oncancel}>Cancel</Button>
    <Button size="sm" variant="primary" onclick={save}>Save</Button>
  </div>
</div>
