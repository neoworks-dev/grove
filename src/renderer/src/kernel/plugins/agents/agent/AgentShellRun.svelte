<script lang="ts">
  // A `!` command the user ran. `shared` decides whether the model saw it.
  // While it runs, what it prints streams in under it, with Stop and
  // Background (Ctrl+B) beside it.
  import { outputTail } from '../../../../lib/agents/outputTail'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import { agentTerminal } from '../../../../lib/agents/agentTerminal.svelte'
  import type { ShellItem } from '../../../../lib/agents/transcript'
  import { highlightCode, type HighlightedToken } from '../../../../lib/highlight'
  import { store } from '../../../../lib/store.svelte'

  let { item, sessionId }: { item: ShellItem; sessionId: string } = $props()

  const LIVE_TAIL_LINES = 12

  const liveOutput = $derived.by(() => {
    if (!item.running || !item.shellId) return undefined
    return shellOutputs.of(sessionId, item.shellId)
  })
  const liveTail = $derived(liveOutput ? outputTail(liveOutput.text, LIVE_TAIL_LINES) : [])
  const stoppable = $derived(liveOutput?.running === true)

  /** Joins highlighted lines with a space, as the one-line header collapses a multi-line command. */
  function onOneLine(lines: HighlightedToken[][]): HighlightedToken[] {
    return lines.flatMap((line, index) => {
      if (index === 0) return line
      return [{ text: ' ', color: '' }, ...line]
    })
  }

  // The command coloured as shell once the grammar has it; plain until then.
  let commandTokens = $state<HighlightedToken[]>([])
  $effect(() => {
    const command = item.command
    const scheme = store.activeTheme.scheme
    let current = true
    commandTokens = []
    void highlightCode(command, 'shell', scheme).then((lines) => {
      if (current && lines) commandTokens = onOneLine(lines)
    })
    return () => {
      current = false
    }
  })
</script>

<div class="mb-2">
  <div class="flex items-center gap-2 font-mono text-2xs">
    <span class="shrink-0 text-blue">$</span>
    <span class="min-w-[8ch] truncate text-muted"
      >{#if commandTokens.length > 0}{#each commandTokens as token, index (index)}<span
            style:color={token.color}>{token.text}</span
          >{/each}{:else}{item.command}{/if}</span
    >
    {#if item.running}<span class="shrink-0 text-dim">· running</span>{/if}
    {#if item.fromTerminal}<span class="min-w-0 truncate text-dim">· in your terminal</span>{/if}
    {#if !item.shared}<span class="shrink-0 text-dim">· private</span
      >{:else if !item.running && !item.delivered}<span class="min-w-0 truncate text-amber"
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
        {#if liveOutput?.waitingForInput}
          <span class="self-center text-amber">Waiting for input</span>
        {/if}
        <button
          class="rounded border border-line px-1.5 hover:bg-hover hover:text-default"
          class:border-amber={liveOutput?.waitingForInput}
          class:text-amber={liveOutput?.waitingForInput}
          title="Type into it in the agent terminal"
          onclick={() => agentTerminal.show(sessionId, shellId)}
        >
          Answer in terminal
        </button>
        <button
          class="rounded border border-line px-1.5 hover:bg-hover hover:text-red"
          title="Stop the command, as Ctrl+C would"
          onclick={() => shellOutputs.interrupt(sessionId, shellId)}
        >
          Stop
        </button>
        {#if !liveOutput?.background}
          <button
            class="rounded border border-line px-1.5 hover:bg-hover hover:text-default"
            title="Let it run past the time limit (Ctrl+B)"
            onclick={() => shellOutputs.background(sessionId)}
          >
            Background
          </button>
        {/if}
      </div>
    {/if}
  {:else if item.output}
    <pre
      class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap pl-4 font-mono text-2xs text-dim">{item.output}</pre>
  {/if}
</div>
