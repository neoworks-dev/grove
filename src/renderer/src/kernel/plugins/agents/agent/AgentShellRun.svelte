<script lang="ts">
  // A `!` command the user ran. `shared` decides whether the model saw it.
  // While it runs, what it prints streams in under it, with Stop and
  // Background (Ctrl+B) beside it.
  import { outputTail } from '../../../../lib/agents/outputTail'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import type { ShellItem } from '../../../../lib/agents/transcript'

  let { item, sessionId }: { item: ShellItem; sessionId: string } = $props()

  const LIVE_TAIL_LINES = 12

  const liveOutput = $derived.by(() => {
    if (!item.running || !item.shellId) return undefined
    return shellOutputs.of(sessionId, item.shellId)
  })
  const liveTail = $derived(liveOutput ? outputTail(liveOutput.text, LIVE_TAIL_LINES) : [])
  const stoppable = $derived(liveOutput?.running === true)
</script>

<div class="mb-2">
  <div class="flex items-center gap-2 font-mono text-2xs">
    <span class="shrink-0 text-blue">$</span>
    <span class="min-w-0 truncate text-muted">{item.command}</span>
    {#if item.running}<span class="shrink-0 text-dim">· running</span>{/if}
    {#if !item.shared}<span class="shrink-0 text-dim">· private</span
      >{:else if !item.running && !item.delivered}<span class="shrink-0 text-amber"
        >· goes with your next message</span
      >{:else if item.background}<span class="shrink-0 text-dim">· sent to the agent when it exited</span
      >{/if}
    {#if !item.running && item.exitCode !== 0}<span class="shrink-0 text-red"
        >· exit {item.exitCode}</span
      >{/if}
  </div>
  {#if item.running}
    {#if liveTail.length > 0}
      <pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-dim">{liveTail.join(
          '\n'
        )}</pre>
    {/if}
    {#if stoppable && item.shellId}
      {@const shellId = item.shellId}
      <div class="ml-4 mt-1 flex gap-1.5 text-2xs text-dim">
        <button
          class="rounded border border-line px-1.5 hover:bg-hover hover:text-red"
          title="Stop the command, as Ctrl+C would"
          onclick={() => shellOutputs.interrupt(sessionId, shellId)}
        >
          Stop
        </button>
        <button
          class="rounded border border-line px-1.5 hover:bg-hover hover:text-default"
          title="Let it run past the time limit (Ctrl+B)"
          onclick={() => shellOutputs.background(sessionId)}
        >
          Background
        </button>
      </div>
    {/if}
  {:else if item.output}
    <pre
      class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-dim">{item.output}</pre>
  {/if}
</div>
