<script lang="ts">
  // One issue on the board: number, title, labels and assignees, and what an
  // agent working on it is doing. Dragging it onto another column sets the
  // board's field; clicking it opens the issue's thread.
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import { issueAgentBadge } from './store.svelte'
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

  const AGENT_DOTS: Record<SessionBadge, string> = {
    running: 'bg-violet',
    requires_action: 'bg-amber',
    error: 'bg-red',
    idle: 'bg-dim'
  }

  const agent = $derived(issueAgentBadge(issue.number))

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
  class:border-line={!selected}
  class:border-line-strong={selected}
  class:bg-elevated={selected}
  role="button"
  tabindex="0"
  draggable="true"
  aria-current={selected}
  ondragstart={startDrag}
  onclick={onopen}
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

  {#if issue.labels.length > 0 || agent}
    <div class="flex flex-wrap items-center gap-1">
      {#each issue.labels as label (label.name)}
        <GithubLabelPill {label} />
      {/each}
      {#if agent}
        <span
          class="ml-auto flex items-center gap-1 text-2xs text-muted"
          title="Agent: {AGENT_LABELS[agent]}"
        >
          <span class="size-1.5 rounded-full {AGENT_DOTS[agent]}"></span>
          {AGENT_LABELS[agent]}
        </span>
      {/if}
    </div>
  {/if}
</div>
