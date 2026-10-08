<script lang="ts">
  // One process in the list: its state and name, why it failed or was
  // skipped, and what it waits on. The command lives in the detail panel,
  // where it fits. Hovering swaps the state for its start / stop actions.
  import type { ProcessView } from '../messages'
  import ProcessActions from './ProcessActions.svelte'
  import StatusDot from './StatusDot.svelte'
  import { projectState } from './project.svelte'
  import {
    dependencyDetails,
    dependencySummary,
    restartLabel,
    rowStatusLabel,
    skipReason
  } from './status'

  let { process }: { process: ProcessView } = $props()

  const selected = $derived(projectState.selected === process.name && !projectState.groupSelected)
  const failed = $derived(process.status === 'failed')
  // Why it isn't running: the last line a failed run printed, or the
  // dependency that kept a skipped one from starting.
  const reason = $derived(reasonFor(process))

  /** The line explaining a failed or skipped process; '' otherwise. */
  function reasonFor(view: ProcessView): string {
    if (view.status === 'failed') return projectState.lastLines[view.name] ?? ''
    return skipReason(view, projectState.project?.processes ?? [])
  }
</script>

<div
  class="group flex cursor-pointer flex-col rounded-md px-2 py-1 outline-none focus-visible:shadow-none"
  class:bg-elevated={selected}
  class:hover:bg-hover={!selected}
  role="option"
  aria-selected={selected}
  data-cursor={selected}
  tabindex="-1"
  onclick={() => projectState.select(process.name)}
  onkeydown={() => {}}
>
  <div class="flex min-h-5 min-w-0 items-center gap-2">
    <StatusDot status={process.status} />
    <span class="min-w-0 truncate text-xs text-default" class:text-dim={process.disabled}>
      {process.name}
    </span>
    <span class="ml-auto flex shrink-0 items-center gap-1.5 text-2xs group-hover:hidden">
      {#if restartLabel(process)}
        <span class="text-amber" title="Restarted {process.restarts} times">{restartLabel(process)}</span>
      {/if}
      <span class:text-dim={!failed} class:text-red={failed}>
        {rowStatusLabel(process, projectState.now)}
      </span>
    </span>
    <span class="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
      <ProcessActions {process} />
    </span>
  </div>
  {#if reason}
    <div
      class="truncate pl-4 text-2xs"
      class:font-mono={failed}
      class:text-red={failed}
      class:text-dim={!failed}
      title={reason}
    >
      {reason}
    </div>
  {/if}
  {#if process.dependsOn.length > 0}
    <div class="truncate pl-4 text-2xs text-faint" title={dependencyDetails(process.dependsOn)}>
      {dependencySummary(process.dependsOn)}
    </div>
  {/if}
</div>
