<script lang="ts">
  // The filter over the process list: narrows it by name as you type. `/`
  // focuses it; Enter hands the keys back to the list, keeping the filter;
  // Escape clears it and does the same.
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon'
  import { projectState } from './project.svelte'
  import { KEY_HINTS } from './keys'

  let inputEl = $state<HTMLInputElement>()

  // Take focus whenever a key asks for it.
  $effect(() => {
    if (projectState.filterFocusRequests === 0) return
    inputEl?.focus()
    inputEl?.select()
  })

  /** Enter and Escape leave the box; Escape also clears it. Up/Down move the cursor without leaving. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      projectState.filter = ''
      inputEl?.blur()
    } else if (event.key === 'Enter') {
      inputEl?.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      projectState.step(event.key === 'ArrowDown' ? 1 : -1)
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<label
  class="mx-1 mt-1 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-dim focus-within:bg-raised hover:bg-hover"
>
  <MagnifyingGlassIcon size={12} class="shrink-0" />
  <input
    bind:this={inputEl}
    bind:value={projectState.filter}
    class="min-w-0 flex-1 bg-transparent text-xs text-default outline-none placeholder:text-faint"
    placeholder="Filter ({KEY_HINTS.filter})"
    spellcheck="false"
    onkeydown={onKeydown}
  />
</label>
