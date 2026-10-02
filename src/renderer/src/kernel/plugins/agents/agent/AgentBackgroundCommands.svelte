<script lang="ts">
  // The session's commands still running in the background, between the
  // composer and its controls. Their calls have returned, so this is the one
  // place left to stop them.
  import { backgroundCommandsOf } from '../../../../lib/agents/backgroundCommands'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import type { TranscriptItem } from '../../../../lib/agents/transcript'

  let { sessionId, items }: { sessionId: string; items: TranscriptItem[] } = $props()

  const commands = $derived(backgroundCommandsOf(items, shellOutputs.forSession(sessionId)))
</script>

{#if commands.length > 0}
  <div class="mt-1.5 flex max-h-24 flex-col gap-1 overflow-auto">
    {#each commands as command (command.id)}
      <div
        class="flex items-center gap-2 rounded-md border border-line bg-elevated px-2 py-1 text-2xs text-muted"
      >
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-green" aria-hidden="true"></span>
        <span class="min-w-0 flex-1 truncate font-mono" title={command.command}>
          {command.command}
        </span>
        <button
          class="shrink-0 rounded border border-line px-1.5 hover:bg-hover hover:text-red"
          title="Stop the command, as Ctrl+C would"
          onclick={() => shellOutputs.interrupt(sessionId, command.id)}
        >
          Stop
        </button>
      </div>
    {/each}
  </div>
{/if}
