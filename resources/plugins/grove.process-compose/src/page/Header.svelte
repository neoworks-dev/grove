<script lang="ts">
  // The pane's header row, laid out like Grove's own: title, worktree, what is
  // running, and room at the end for the close button Grove draws over it.
  import StackIcon from 'phosphor-svelte/lib/StackIcon'
  import { StatusBadge } from '@neoworks-dev/ui'
  import { projectState } from './project.svelte'

  const processes = $derived(projectState.project?.processes ?? [])
  const running = $derived(processes.filter((process) => process.status === 'running').length)
  const failed = $derived(processes.filter((process) => process.status === 'failed').length)
</script>

<div
  class="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-[calc(0.75rem+var(--grove-pane-controls-inset,0px))]"
>
  <StackIcon size={14} class="shrink-0 text-dim" />
  <span class="text-xs font-semibold text-default">Processes</span>
  {#if projectState.project?.branch}
    <span class="min-w-0 truncate rounded bg-raised px-1 text-2xs text-dim">
      {projectState.project.branch}
    </span>
  {/if}
  <span class="flex-1"></span>
  {#if running > 0}
    <StatusBadge tone="green">{running} running</StatusBadge>
  {/if}
  {#if failed > 0}
    <StatusBadge tone="red">{failed} failed</StatusBadge>
  {/if}
</div>
