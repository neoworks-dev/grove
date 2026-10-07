<script lang="ts">
  // The selected process: its state and command over its live output.
  import { StatusBadge } from '@neoworks-dev/ui'
  import type { ProcessView } from '../messages'
  import ProcessActions from './ProcessActions.svelte'
  import ProcessTerminal from './ProcessTerminal.svelte'
  import StatusDot from './StatusDot.svelte'
  import { statusLabel, statusTone } from './status'

  let { process }: { process: ProcessView } = $props()

  const where = $derived(process.workingDir === '.' ? '' : `in ${process.workingDir}`)
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line-faint px-3">
    <StatusDot status={process.status} />
    <span class="shrink-0 text-xs font-semibold text-default">{process.name}</span>
    <StatusBadge tone={statusTone(process.status)}>{statusLabel(process)}</StatusBadge>
    <span class="min-w-0 truncate font-mono text-2xs text-dim" title="{process.command} {where}">
      {process.command}
    </span>
    {#if where}
      <span class="shrink-0 text-2xs text-faint">{where}</span>
    {/if}
    <span class="flex-1"></span>
    <ProcessActions {process} />
  </div>
  <div class="min-h-0 flex-1 py-2 pl-3">
    <!-- A fresh terminal per process; it replays what the process printed. -->
    {#key process.name}
      <ProcessTerminal name={process.name} />
    {/key}
  </div>
</div>
