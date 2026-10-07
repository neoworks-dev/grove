<script lang="ts">
  // One process in the list: its state, name and command, and what it waits
  // on. Hovering swaps the state for its start / stop actions.
  import type { ProcessView } from '../messages'
  import ProcessActions from './ProcessActions.svelte'
  import StatusDot from './StatusDot.svelte'
  import { projectState } from './project.svelte'
  import { conditionSuffix, statusLabel } from './status'

  let { process }: { process: ProcessView } = $props()

  const selected = $derived(projectState.selected === process.name)
</script>

<div
  class="group flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5"
  class:bg-elevated={selected}
  class:hover:bg-hover={!selected}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={() => projectState.select(process.name)}
  onkeydown={() => {}}
>
  <div class="flex min-h-5 min-w-0 items-center gap-2">
    <StatusDot status={process.status} />
    <span class="min-w-0 truncate text-xs text-default">{process.name}</span>
    <span class="ml-auto shrink-0 text-2xs text-dim group-hover:hidden">{statusLabel(process)}</span
    >
    <span class="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
      <ProcessActions {process} />
    </span>
  </div>
  <div class="truncate pl-4 font-mono text-2xs text-dim" title={process.command}>
    {process.command || '(no command)'}
  </div>
  {#if process.dependsOn.length > 0}
    <div class="flex flex-wrap gap-1 pl-4">
      {#each process.dependsOn as dependency (dependency.name)}
        <span class="rounded bg-raised px-1 text-2xs text-dim" title={dependency.condition}>
          after {dependency.name}{conditionSuffix(dependency.condition)}
        </span>
      {/each}
    </div>
  {/if}
</div>
