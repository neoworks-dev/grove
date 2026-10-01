<script lang="ts">
  // Every session, its threads, and the frames of the stopped ones. Picking a
  // frame focuses it — the variables and evaluate follow — and opens its line.
  import type {
    DebugSessionSummary,
    DebugStackFrame,
    DebugThread
  } from '../../../../../shared/debug'
  import DebugSection from './DebugSection.svelte'
  import { debug } from './store.svelte'

  const sessions = $derived(debug.sessions.filter((session) => session.state !== 'terminated'))
  const showSessionRows = $derived(sessions.length > 1)

  /** The frame's file and line, or the adapter's name for code with no file. */
  function locationOf(frame: DebugStackFrame): string {
    let name = frame.sourceName
    if (frame.path) {
      name = frame.path.split('/').pop()
    }
    if (!name) {
      return ''
    }
    return `${name}:${frame.line}`
  }

  function threadState(thread: DebugThread): string {
    if (thread.stopped) {
      return 'Paused'
    }
    return 'Running'
  }

  function isFocused(session: DebugSessionSummary, frame: DebugStackFrame): boolean {
    return (
      session.id === debug.snapshot.focusedSessionId && frame.id === debug.snapshot.focusedFrameId
    )
  }
</script>

<DebugSection title="Call Stack">
  {#if sessions.length === 0}
    <p class="px-3 py-1 text-2xs text-dim">Not debugging.</p>
  {/if}
  {#each sessions as session (session.id)}
    {#if showSessionRows}
      <div class="flex h-5 items-center px-3 text-xs text-default">
        <span class="truncate">{session.name}</span>
      </div>
    {/if}
    {#each session.threads as thread (thread.id)}
      <div class="flex h-5 items-center gap-2 px-3 text-xs" class:pl-5={showSessionRows}>
        <span class="min-w-0 flex-1 truncate text-default">{thread.name}</span>
        <span
          class="shrink-0 text-2xs uppercase tracking-caps"
          class:text-amber={thread.stopped}
          class:text-dim={!thread.stopped}
        >
          {threadState(thread)}
        </span>
      </div>
      {#each thread.frames as frame (frame.id)}
        <button
          class="flex h-5 w-full min-w-0 items-center gap-2 pr-3 text-left text-xs hover:bg-hover"
          class:pl-6={!showSessionRows}
          class:pl-8={showSessionRows}
          class:bg-raised={isFocused(session, frame)}
          class:text-dim={frame.presentationHint === 'subtle'}
          title={frame.path || frame.sourceName || frame.name}
          onclick={() => void debug.selectFrame(session.id, thread.id, frame.id)}
        >
          <span class="min-w-0 flex-1 truncate font-mono">{frame.name}</span>
          <span class="shrink-0 truncate text-2xs text-dim">{locationOf(frame)}</span>
        </button>
      {/each}
    {/each}
  {/each}
</DebugSection>
