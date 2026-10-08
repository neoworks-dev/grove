<script lang="ts">
  // One issue on the board: number, title, labels and assignees, and below
  // them a card of its own for the agent working on it: the session, what it is
  // doing, and what its branch changes so far. Dragging the issue onto another
  // column sets the board's field; clicking it opens the issue's thread, and
  // clicking the agent's card opens the session.
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import { issueAgent, openIssueAgent, prefetchItem } from './store.svelte'
  import { ageLabel } from '../../../lib/time'
  import { store } from '../../../lib/store.svelte'
  import type { SessionBadge } from '../../../lib/agents/sessions.svelte'
  import type { GithubIssueItem } from '../../../../../shared/types'

  let {
    issue,
    selected,
    onopen
  }: {
    issue: GithubIssueItem
    selected: boolean
    onopen: () => void
  } = $props()

  const AGENT_LABELS: Record<SessionBadge, string> = {
    running: 'working',
    requires_action: 'needs you',
    error: 'failed',
    idle: 'idle'
  }

  const AGENT_TEXT: Record<SessionBadge, string> = {
    running: 'text-violet',
    requires_action: 'text-amber',
    error: 'text-red',
    idle: 'text-dim'
  }

  const agent = $derived(issueAgent(issue.number))

  /**
   * The card's border while an agent is on it, so a busy issue stands out on
   * the board: amber while it works or waits on the user, red when it failed.
   */
  const frame = $derived.by<'active' | 'failed' | null>(() => {
    if (!agent) return null
    if (agent.badge === 'running' || agent.badge === 'requires_action') return 'active'
    if (agent.badge === 'error') return 'failed'
    return null
  })

  /** The session's title without the "Issue #12: " it was started with, which the card already says. */
  const sessionTitle = $derived.by(() => {
    if (!agent) return ''
    return agent.session.title.replace(/^Issue #\d+:\s*/, '')
  })

  /**
   * What the agent's branch changes against its base, once there is something.
   * Before the main process reports that, the worktree's uncommitted lines stand in.
   */
  const changes = $derived.by(() => {
    if (!agent) return null
    const position = store.branchPositions[agent.worktree.id]
    if (position && position.changes) {
      if (position.changes.files === 0) return null
      return position.changes
    }
    const uncommitted = store.diffStats[agent.worktree.id]
    if (!uncommitted || uncommitted.files.length === 0) return null
    return {
      added: uncommitted.added,
      removed: uncommitted.removed,
      files: uncommitted.files.length
    }
  })

  /** Opens the agent's session rather than the issue under it. */
  function openAgent(event: Event): void {
    event.stopPropagation()
    if (agent) openIssueAgent(agent)
  }

  function onAgentKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openAgent(event)
  }

  /** Hands the issue's number to the drop, which looks the issue up again. */
  function startDrag(event: DragEvent): void {
    if (!event.dataTransfer) return
    event.dataTransfer.setData('application/x-grove-issue', String(issue.number))
    event.dataTransfer.effectAllowed = 'move'
  }

  /** Opens the issue from the keyboard as a click would. */
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onopen()
  }
</script>

<div
  class="flex cursor-pointer flex-col gap-1.5 rounded-md border bg-surface px-2 py-1.5 transition-colors duration-100 hover:bg-hover"
  class:border-line={!selected && !frame}
  class:border-line-strong={selected && !frame}
  class:border-amber={frame === 'active'}
  class:border-red={frame === 'failed'}
  class:bg-elevated={selected}
  role="button"
  tabindex="0"
  draggable="true"
  aria-current={selected}
  ondragstart={startDrag}
  onclick={onopen}
  onmouseenter={() => prefetchItem('issue', issue.number)}
  onkeydown={onKey}
>
  <div class="flex items-center gap-1.5 text-2xs text-dim">
    <span class="font-mono">#{issue.number}</span>
    {#if issue.assignees.length > 0}
      <span class="ml-auto flex items-center -space-x-1">
        {#each issue.assignees as assignee (assignee.login)}
          <GithubAvatar actor={assignee} size={14} />
        {/each}
      </span>
    {/if}
  </div>

  <span class="text-xs text-default">{issue.title}</span>

  {#if issue.excerpt}
    <p class="line-clamp-3 text-2xs text-dim">{issue.excerpt}</p>
  {/if}

  {#if issue.labels.length > 0}
    <div class="flex flex-wrap items-center gap-1">
      {#each issue.labels as label (label.name)}
        <GithubLabelPill {label} />
      {/each}
    </div>
  {/if}

  {#if agent}
    <div
      class="flex flex-col gap-1 rounded-md border border-line bg-default/[0.07] px-2 py-1.5 hover:bg-default/[0.1]"
      role="button"
      tabindex="0"
      title="Open the agent session in {agent.worktree.name}"
      onclick={openAgent}
      onkeydown={onAgentKey}
    >
      <span class="truncate text-xs text-default">{sessionTitle}</span>
      <span class="flex items-center gap-1.5 text-2xs text-dim">
        {#if agent.badge === 'running'}
          <span class="flex items-center gap-0.5" aria-label="working">
            {#each [0, 1, 2] as dot (dot)}
              <span
                class="size-1 animate-pulse rounded-full bg-amber"
                style:animation-delay="{dot * 200}ms"
              ></span>
            {/each}
          </span>
        {:else if agent.badge !== 'idle'}
          <span class={AGENT_TEXT[agent.badge]}>{AGENT_LABELS[agent.badge]}</span>
          <span>·</span>
        {/if}
        <span>{ageLabel(agent.session.updatedAt)}</span>
        {#if changes}
          <span>·</span>
          <span>
            {changes.files}
            {#if changes.files === 1}file{:else}files{/if}
          </span>
          <span class="text-green">+{changes.added}</span>
          <span class="text-red">-{changes.removed}</span>
        {/if}
      </span>
    </div>
  {/if}
</div>
