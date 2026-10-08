<script lang="ts">
  // Every process in the project, filtered by name, with the ones the file
  // disables collapsed into a group at the bottom. The keys (keys.ts) listen on
  // the whole page so they work as soon as the pane has focus, without
  // clicking the list first.
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import { FloatingScrollbar } from '@neoworks-dev/ui'
  import ListFilter from './ListFilter.svelte'
  import ProcessRow from './ProcessRow.svelte'
  import { projectState } from './project.svelte'
  import { handlePaneKey } from './keys'

  let listEl = $state<HTMLDivElement>()

  const enabled = $derived(projectState.enabledProcesses)
  const disabled = $derived(projectState.disabledProcesses)

  // Keep the cursor's row in view as it moves.
  $effect(() => {
    void projectState.selected
    void projectState.groupSelected
    void projectState.disabledOpen
    const row = listEl?.querySelector('[data-cursor="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  })

  /**
   * Runs the pane's keys ahead of everything on the page. A handled key stops
   * here: the SDK then doesn't pass it up to Grove, and a focused terminal
   * doesn't also receive it (Ctrl+F).
   */
  function onKeydown(event: KeyboardEvent): void {
    if (!handlePaneKey(event)) return
    event.preventDefault()
    event.stopPropagation()
  }

  /** Clicking the Disabled header toggles it and puts the cursor there. */
  function onGroupClick(): void {
    projectState.selectGroup()
    projectState.setDisabledOpen(!projectState.showDisabled)
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

<div class="flex min-h-0 flex-1 flex-col">
  <ListFilter />
  <div bind:this={listEl} class="min-h-0 flex-1" role="listbox">
    <FloatingScrollbar class="h-full">
      <div class="flex flex-col gap-px p-1">
        {#each enabled as process (process.name)}
          <ProcessRow {process} />
        {/each}
        {#if disabled.length > 0}
          <button
            class="mt-1 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-2xs text-dim outline-none hover:bg-hover hover:text-default focus-visible:shadow-none"
            class:bg-elevated={projectState.groupSelected}
            class:text-default={projectState.groupSelected}
            data-cursor={projectState.groupSelected}
            tabindex="-1"
            onclick={onGroupClick}
          >
            <CaretRightIcon
              size={10}
              class="shrink-0 transition-transform {projectState.disabledOpen ? 'rotate-90' : ''}"
            />
            Disabled ({disabled.length})
          </button>
          {#if projectState.disabledOpen}
            {#each disabled as process (process.name)}
              <ProcessRow {process} />
            {/each}
          {/if}
        {/if}
        {#if enabled.length === 0 && disabled.length === 0}
          <p class="px-2 py-1 text-2xs text-dim">No process matches “{projectState.filter}”.</p>
        {/if}
      </div>
    </FloatingScrollbar>
  </div>
</div>
