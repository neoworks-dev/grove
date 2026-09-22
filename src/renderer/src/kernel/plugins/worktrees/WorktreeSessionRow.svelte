<script lang="ts">
  // One agent session under its worktree: its name and where it stands on the
  // first line, the last thing said in it on the second. Clicking opens it in
  // the Agent pane.
  import AgentLogo from '../../../components/AgentLogo.svelte'
  import WaveSpinner from '../../../components/WaveSpinner.svelte'
  import { relativeTime } from '../../../lib/time'
  import type { SessionMeta } from '../../../lib/agents/types'
  import { ATTENTION_LABELS, type SessionAttention } from '../../../lib/agents/attention'

  let {
    session,
    attention,
    selected,
    onopen
  }: {
    session: SessionMeta
    /** How its last turn ended, when that happened out of sight. */
    attention?: SessionAttention
    /** Whether the worktree it belongs to is the selected one. */
    selected: boolean
    onopen: (event: MouseEvent) => void
  } = $props()

  const running = $derived(session.status === 'running')
  const waiting = $derived(!running && session.pendingApprovals.length > 0)

  /** The session's name, falling back to its model for one that has none. */
  const title = $derived.by(() => {
    if (session.title.trim().length > 0) return session.title
    if (session.model) return session.model
    return 'Session'
  })

  // Your own last message reads as yours, so a session waiting on the agent is
  // told apart from one waiting on you.
  const previewPrefix = $derived.by(() => {
    if (session.preview?.from === 'user') return 'You: '
    return ''
  })
</script>

<button
  class="flex w-full items-start gap-2 py-1.5 pl-7 pr-3 text-left hover:bg-hover"
  class:bg-elevated={selected}
  title="{title} · {session.provider}/{session.model} — {session.status}"
  onclick={onopen}
>
  <span class="mt-0.5 shrink-0">
    <AgentLogo harness={session.harness} size={16} active={running} />
  </span>
  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-xs" class:text-default={running || attention} class:text-muted={!running && !attention}>
        {title}
      </span>
      {#if running}
        <span class="shrink-0 text-green"><WaveSpinner count={3} /></span>
      {:else if attention}
        <span
          class="flex shrink-0 items-center gap-1 text-2xs font-medium"
          class:text-green={attention === 'done'}
          class:text-amber={attention === 'needs_you'}
          class:text-red={attention === 'failed'}
        >
          <span class="size-1.5 rounded-full bg-current"></span>
          {ATTENTION_LABELS[attention]}
        </span>
      {:else if waiting}
        <span class="shrink-0 text-2xs text-amber">waiting</span>
      {:else}
        <span class="shrink-0 text-2xs text-dim" title={session.updatedAt}>
          {relativeTime(session.updatedAt)}
        </span>
      {/if}
    </span>
    {#if session.preview}
      <span class="truncate text-2xs text-dim">{previewPrefix}{session.preview.text}</span>
    {/if}
  </span>
</button>
