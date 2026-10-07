<script lang="ts">
  // Start, or restart and stop, for one process.
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon'
  import StopIcon from 'phosphor-svelte/lib/StopIcon'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import type { ProcessView } from '../messages'
  import IconAction from './IconAction.svelte'
  import { projectState } from './project.svelte'
  import { isLive } from './status'

  let { process }: { process: ProcessView } = $props()
</script>

{#if isLive(process.status)}
  <IconAction
    icon={ArrowClockwiseIcon}
    title="Restart {process.name}"
    onclick={() => projectState.send({ type: 'restart', name: process.name })}
  />
  <IconAction
    icon={StopIcon}
    title="Stop {process.name}"
    tone="danger"
    onclick={() => projectState.send({ type: 'stop', name: process.name })}
  />
{:else}
  <IconAction
    icon={PlayIcon}
    title="Start {process.name}"
    onclick={() => projectState.send({ type: 'start', name: process.name })}
  />
{/if}
