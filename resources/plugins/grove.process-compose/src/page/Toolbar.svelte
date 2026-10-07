<script lang="ts">
  // The project's controls: which config file, and start / restart / stop for
  // all of it — a toolbar row like Grove's Run and Debug view has.
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon'
  import StopIcon from 'phosphor-svelte/lib/StopIcon'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon'
  import { Button, Select } from '@neoworks-dev/ui'
  import IconAction from './IconAction.svelte'
  import { projectState } from './project.svelte'
  import { isLive } from './status'

  const project = $derived(projectState.project)
  const files = $derived(project?.files ?? [])
  const live = $derived((project?.processes ?? []).some((process) => isLive(process.status)))
  const options = $derived(files.map((file) => ({ value: file, label: file })))

  /** Switches to another config file in the worktree. */
  function selectFile(value: string | string[]): void {
    if (typeof value !== 'string') return
    projectState.send({ type: 'select-file', file: value })
  }
</script>

<div class="flex shrink-0 items-center gap-2 border-b border-line-faint px-3 py-2">
  <div class="flex min-w-0 flex-1 items-center gap-1.5">
    {#if files.length > 1}
      <div class="min-w-0 flex-1">
        <Select size="sm" value={project?.file ?? ''} {options} onChange={selectFile} />
      </div>
    {:else}
      <span class="min-w-0 truncate font-mono text-2xs text-dim">{project?.file}</span>
    {/if}
    <IconAction
      icon={FileTextIcon}
      title="Open the config file"
      onclick={() => projectState.send({ type: 'open-file' })}
    />
  </div>
  {#if live}
    <Button
      size="sm"
      icon={ArrowClockwiseIcon}
      onclick={() => projectState.send({ type: 'restart' })}
    >
      Restart all
    </Button>
    <Button
      size="sm"
      variant="danger"
      icon={StopIcon}
      onclick={() => projectState.send({ type: 'stop' })}
    >
      Stop all
    </Button>
  {:else}
    <Button
      size="sm"
      variant="primary"
      icon={PlayIcon}
      onclick={() => projectState.send({ type: 'start' })}
    >
      Start all
    </Button>
  {/if}
</div>
