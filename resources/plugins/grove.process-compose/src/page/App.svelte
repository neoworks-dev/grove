<script lang="ts">
  // The Process Compose pane: header, the project's controls, and the process
  // list beside the selected process's output. Narrow panes stack the two.
  import { onMount } from 'svelte'
  import EmptyState from './EmptyState.svelte'
  import Header from './Header.svelte'
  import ProcessDetail from './ProcessDetail.svelte'
  import ProcessList from './ProcessList.svelte'
  import Toolbar from './Toolbar.svelte'
  import { projectState } from './project.svelte'

  // Below this width the list goes above the output instead of beside it.
  const STACK_BELOW_PX = 560

  let width = $state(0)

  const project = $derived(projectState.project)
  const hasProcesses = $derived(Boolean(project?.file) && (project?.processes.length ?? 0) > 0)
  const stacked = $derived(width > 0 && width < STACK_BELOW_PX)
  // The list beside the output, or above it in a narrow pane.
  const listPlacement = $derived(listPlacementClasses(stacked))

  /** Where the process list sits: a column on the left, or a band on top. */
  function listPlacementClasses(isStacked: boolean): string {
    if (isStacked) return 'max-h-[40%] border-b border-line'
    return 'w-64 border-r border-line'
  }

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
      <Toolbar />
      <div class="flex min-h-0 flex-1" class:flex-col={stacked}>
        <div class="flex min-h-0 shrink-0 flex-col {listPlacement}">
          <ProcessList />
        </div>
        {#if projectState.selectedProcess}
          <ProcessDetail process={projectState.selectedProcess} />
        {/if}
      </div>
    {:else}
      <EmptyState />
    {/if}
  {/if}
</div>
