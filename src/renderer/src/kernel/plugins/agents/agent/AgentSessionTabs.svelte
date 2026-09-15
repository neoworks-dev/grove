<script lang="ts">
  // One tab per agent session in this worktree, plus a button to start another.
  //
  // The badge is the whole point of showing sessions you are not looking at: a
  // session blocked on an approval elsewhere is the one thing you need to be told
  // about without switching to it.
  //
  // Sessions an agent spawned sit inside the same bordered group as the session
  // that spawned them, marked with a ↳, so a delegated conversation reads as part
  // of the one that started it rather than as an unrelated tab beside it.

  import AgentLogo from '../../../../components/AgentLogo.svelte'
  import WaveSpinner from '../../../../components/WaveSpinner.svelte'
  import { sessionFamilies } from '../../../../lib/agents/sessionTree'
  import type { SessionBadge } from '../../../../lib/agents/sessions.svelte'
  import type { SessionMeta } from '../../../../lib/agents/types'

  let {
    sessions,
    activeId,
    badgeFor,
    unreadFor,
    onSelect,
    onClose,
    onCreate
  }: {
    sessions: SessionMeta[]
    activeId: string | null
    badgeFor: (session: SessionMeta) => SessionBadge
    unreadFor: (session: SessionMeta) => number
    onSelect: (sessionId: string) => void
    onClose: (sessionId: string, event: MouseEvent) => void
    onCreate: () => void
  } = $props()

  const families = $derived(sessionFamilies(sessions))

  function titleOf(session: SessionMeta): string {
    if (session.title.trim().length > 0) return session.title
    return session.model || 'Session'
  }

  /** What the tab's tooltip says, including who started it. */
  function tooltipOf(session: SessionMeta, depth: number): string {
    const model = `${session.provider}/${session.model}`
    if (depth === 0) return `${titleOf(session)} · ${model} (${badgeFor(session)})`
    return `${titleOf(session)} · ${model} (${badgeFor(session)}) · spawned by another agent`
  }
</script>

<div class="no-scrollbar flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto px-1.5">
  {#each families as family (family[0].session.id)}
    <!-- One box per family: a lone session keeps the bare tab it always had. -->
    <div
      class="flex shrink-0 items-center"
      class:rounded-md={family.length > 1}
      class:border={family.length > 1}
      class:border-line={family.length > 1}
    >
      {#each family as { session, depth } (session.id)}
        {@const active = session.id === activeId}
        {@const badge = badgeFor(session)}
        {@const unread = unreadFor(session)}
        <div
          class="group/tab flex h-6 shrink-0 items-center px-2 text-xs"
          class:rounded-md={family.length === 1}
          class:bg-elevated={active}
          class:text-default={active}
          class:text-dim={!active}
          class:hover:bg-hover={!active}
          class:hover:text-default={!active}
          class:border-l={depth > 0}
          class:border-line={depth > 0}
          title={tooltipOf(session, depth)}
        >
          <button
            class="flex cursor-pointer items-center gap-1.5"
            onclick={() => onSelect(session.id)}
          >
            {#if depth > 0}
              <!-- Spawned by the tab to its left. -->
              <span class="shrink-0 font-mono text-2xs text-blue" title="Spawned agent">↳</span>
            {/if}
            <AgentLogo harness={session.harness} size={13} {active} />
            <span class="max-w-[12rem] truncate">{titleOf(session)}</span>
            {#if badge === 'running'}
              <span class="text-green"><WaveSpinner count={3} /></span>
            {:else if badge === 'requires_action'}
              <span class="text-amber" title="Waiting for you">●</span>
            {:else if badge === 'error'}
              <span class="text-red" title="Ended with an error">●</span>
            {:else if unread > 0}
              <span class="rounded-full bg-blue/20 px-1 text-2xs text-blue">{unread}</span>
            {/if}
          </button>
          <button
            class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
            title="Delete session"
            onclick={(event) => onClose(session.id, event)}>✕</button
          >
        </div>
      {/each}
    </div>
  {/each}
  <button
    class="flex h-6 shrink-0 items-center rounded-md px-2 text-2xs text-dim hover:bg-hover hover:text-default"
    title="New session in this worktree"
    onclick={onCreate}
  >
    ＋
  </button>
</div>
