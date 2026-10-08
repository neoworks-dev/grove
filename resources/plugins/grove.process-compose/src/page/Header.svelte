<script lang="ts">
  // The pane's header row, laid out like Grove's own: title, worktree, the
  // config file, what is running, and the project's start / restart / stop as
  // icon actions. Room is left at the end for the close button Grove draws.
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon'
  import StopIcon from 'phosphor-svelte/lib/StopIcon'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon'
  import { Select, StatusBadge } from '@neoworks-dev/ui'
  import IconAction from './IconAction.svelte'
  import { projectState } from './project.svelte'
  import { isLive } from './status'
  import { KEY_HINTS } from './keys'

  const project = $derived(projectState.project)
  const processes = $derived(project?.processes ?? [])
  const files = $derived(project?.files ?? [])
  const options = $derived(files.map((file) => ({ value: file, label: file })))
  const running = $derived(processes.filter((process) => process.status === 'running').length)
  const failed = $derived(processes.filter((process) => process.status === 'failed').length)
  const live = $derived(processes.some((process) => isLive(process.status)))
  const hasProcesses = $derived(Boolean(project?.file) && processes.length > 0)

  /** Switches to another config file in the worktree. */
  function selectFile(value: string | string[]): void {
    if (typeof value !== 'string') return
    projectState.send({ type: 'select-file', file: value })
  }
</script>

<div
  class="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-[calc(0.75rem+var(--grove-pane-controls-inset,0px))]"
>
  <span class="shrink-0 text-xs font-semibold text-default">Processes</span>
  {#if project?.branch}
    <span class="min-w-0 shrink truncate rounded bg-raised px-1 text-2xs text-dim">
      {project.branch}
    </span>
  {/if}
  {#if project?.file}
    <div class="flex min-w-0 shrink items-center gap-1">
      {#if files.length > 1}
        <div class="min-w-0 max-w-56">
          <Select size="sm" value={project.file} {options} onChange={selectFile} />
        </div>
      {:else}
        <span class="min-w-0 truncate font-mono text-2xs text-dim">{project.file}</span>
      {/if}
      <IconAction
        icon={FileTextIcon}
        title="Open the config file ({KEY_HINTS.openFile})"
        onclick={() => projectState.send({ type: 'open-file' })}
      />
    </div>
  {/if}
  <span class="flex-1"></span>
  {#if running > 0}
    <StatusBadge tone="green">{running} running</StatusBadge>
  {/if}
  {#if failed > 0}
    <button
      class="shrink-0 cursor-pointer rounded-full"
      title="Show the next failed process ({KEY_HINTS.nextFailed})"
      onclick={() => projectState.selectNextFailed()}
    >
      <StatusBadge tone="red">{failed} failed</StatusBadge>
    </button>
  {/if}
  {#if hasProcesses}
    <div class="flex shrink-0 items-center gap-0.5">
      {#if live}
        <IconAction
          icon={ArrowClockwiseIcon}
          title="Restart all ({KEY_HINTS.restartAll})"
          onclick={() => projectState.send({ type: 'restart' })}
        />
        <IconAction
          icon={StopIcon}
          title="Stop all ({KEY_HINTS.stopAll})"
          tone="danger"
          onclick={() => projectState.send({ type: 'stop' })}
        />
      {:else}
        <IconAction
          icon={PlayIcon}
          title="Start all ({KEY_HINTS.startAll})"
          onclick={() => projectState.send({ type: 'start' })}
        />
      {/if}
    </div>
  {/if}
</div>
