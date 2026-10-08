<script lang="ts">
  // The Process Compose pane: header, the project's controls, and the process
  // list beside the selected process's output. Narrow panes stack the two.
  // Beside the output, the list has a resizable width the worker remembers.
  import { onMount } from 'svelte'
  import EmptyState from './EmptyState.svelte'
  import Header from './Header.svelte'
  import ListResizer from './ListResizer.svelte'
  import ProcessDetail from './ProcessDetail.svelte'
  import ProcessList from './ProcessList.svelte'
  import { projectState } from './project.svelte'

  // Below this width the list goes above the output instead of beside it.
  const STACK_BELOW_PX = 560
  const DEFAULT_LIST_WIDTH = 256

  let width = $state(0)
  // The width while a drag is under way; the stored one otherwise.
  let draggedListWidth = $state<number | null>(null)

  const project = $derived(projectState.project)
  const hasProcesses = $derived(Boolean(project?.file) && (project?.processes.length ?? 0) > 0)
  const stacked = $derived(width > 0 && width < STACK_BELOW_PX)
  const listWidth = $derived(currentListWidth(draggedListWidth, projectState.prefs.listWidth))

  /** The list's width: mid-drag, stored, or the default. */
  function currentListWidth(dragged: number | null, stored: number | null): number {
    if (dragged !== null) return dragged
    if (stored !== null) return stored
    return DEFAULT_LIST_WIDTH
  }

  // A finished drag hands over to the stored width.
  $effect(() => {
    void projectState.prefs.listWidth
    draggedListWidth = null
  })

  onMount(() => projectState.connect())
</script>

<div class="flex h-full flex-col" bind:clientWidth={width}>
  <Header />
  {#if project}
    {#if project.error}
      <div
        class="mx-3 mt-2 shrink-0 whitespace-pre-wrap rounded-md border border-red/30 bg-red-soft px-3 py-2 font-mono text-2xs text-default"
      >
        {project.error}
      </div>
    {/if}
    {#if hasProcesses}
      <div class="flex min-h-0 flex-1" class:flex-col={stacked}>
        {#if stacked}
          <div class="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-line">
            <ProcessList />
          </div>
        {:else}
          <div
            class="relative flex min-h-0 shrink-0 flex-col border-r border-line"
            style="width: {listWidth}px"
          >
            <ProcessList />
            <ListResizer width={listWidth} onresize={(next) => (draggedListWidth = next)} />
          </div>
        {/if}
        {#if projectState.selectedProcess}
          <ProcessDetail process={projectState.selectedProcess} />
        {/if}
      </div>
    {:else}
      <EmptyState />
    {/if}
  {/if}
</div>
