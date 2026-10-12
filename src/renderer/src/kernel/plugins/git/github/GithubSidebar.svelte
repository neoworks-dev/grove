<script lang="ts">
  // The item's metadata, one property to a line: the name on the left, the
  // value on the right, and a value Grove can change opens its editor when
  // clicked. What is done to the item rather than said about it lives in the
  // thread header's … menu.
  //
  // Type and Projects are read-only and only appear at all when the token could
  // be asked for them — see `fetchCapabilities` in githubDashboard.ts. Drawing
  // an empty "Projects" section for someone who never granted `read:project`
  // would report an absence that was never measured.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import WaveSpinner from '../../../../components/WaveSpinner.svelte'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubLabelPicker from './GithubLabelPicker.svelte'
  import GithubMenu from './GithubMenu.svelte'
  import GithubIssueDateSection from './GithubIssueDateSection.svelte'
  import GithubIssueFieldSection from './GithubIssueFieldSection.svelte'
  import GithubMilestoneForm from './GithubMilestoneForm.svelte'
  import GithubStateIcon from './GithubStateIcon.svelte'
  import GithubPropertyRow from './GithubPropertyRow.svelte'
  import { branchNameFor } from './branches'
  import { assigneeLogins, issueTypeColour } from './filter'
  import {
    github,
    applyAssignees,
    applyLabels,
    applyMilestone,
    loadMentionables,
    loadMilestones,
    openReference,
    startWorkOnIssue,
    switchToWorktree,
    worktreesForIssue
  } from './store.svelte'
  import { store } from '../../../../lib/store.svelte'
  import type { GithubItemDetail, GithubItemRef } from '../../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  let editingLabels = $state(false)

  // What the picker holds while it is open: the item's own labels until the
  // user touches them, then whatever they have chosen so far.
  let pending = $state<string[] | null>(null)

  $effect(() => {
    void loadMentionables()
    void loadMilestones()
  })

  const chosen = $derived.by<string[]>(() => {
    if (pending !== null) return pending
    return detail.labels.map((label) => label.name)
  })

  const milestoneTitle = $derived.by<string | null>(() => {
    if (!detail.milestone) return null
    return detail.milestone.title
  })

  function openPicker(): void {
    pending = detail.labels.map((label) => label.name)
    editingLabels = true
  }

  async function closePicker(): Promise<void> {
    const next = pending
    editingLabels = false
    pending = null
    if (next) await applyLabels(next)
  }

  /** Assign or unassign one person, applied as soon as it is clicked. */
  async function toggleAssignee(login: string): Promise<void> {
    const current = assigneeLogins(detail)
    if (current.includes(login)) {
      await applyAssignees(current.filter((entry) => entry !== login))
      return
    }
    await applyAssignees([...current, login])
  }

  /** A milestone's due date and description, for the hover title of its row. */
  function milestoneTooltip(milestone: {
    title: string
    dueOn: string | null
    description?: string | null
  }): string {
    const lines = [milestone.title]
    if (milestone.dueOn !== null)
      lines.push(`Due ${new Date(milestone.dueOn).toLocaleDateString()}`)
    if (milestone.description) lines.push(milestone.description)
    return lines.join('\n')
  }

  // Relationships only exist on issues, and only when the schema has them.
  const showsRelationships = $derived(github.capabilities.subIssues && detail.kind === 'issue')

  const subIssues = $derived.by<GithubItemRef[]>(() => {
    if (!detail.subIssues) return []
    return detail.subIssues
  })

  const linkedBranches = $derived.by<string[]>(() => {
    if (!detail.linkedBranches) return []
    return detail.linkedBranches
  })

  // Worktrees already on one of this issue's branches, to switch to rather than
  // cut another by accident.
  const issueWorktrees = $derived(worktreesForIssue(detail.number))

  /** "3 of 7 done", or null when nothing hangs off this issue. */
  const subIssueProgress = $derived.by<string | null>(() => {
    const progress = detail.subIssueProgress
    if (!progress || progress.total === 0) return null
    return `${progress.completed} of ${progress.total} done`
  })

  /** The open issue's option for a field, or null when it is not set. */
  function fieldValueOf(fieldId: string): string | null {
    if (!detail.fieldValues) return null
    const optionId = detail.fieldValues[fieldId]
    if (optionId === undefined) return null
    return optionId
  }

  /** The open issue's day for a date field, or null when it is not set. */
  function dateValueOf(fieldId: string): string | null {
    if (!detail.dateValues) return null
    const date = detail.dateValues[fieldId]
    if (date === undefined) return null
    return date
  }

  /** The new-milestone form is open under the Milestone heading. */
  let creatingMilestone = $state(false)
</script>

{#snippet refRow(ref: GithubItemRef)}
  <button
    class="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
    onclick={() => openReference('issue', ref.number)}
  >
    <GithubStateIcon item={{ kind: 'issue', state: ref.state }} size={11} />
    <span class="shrink-0 text-dim">#{ref.number}</span>
    <span class="truncate text-default" title={ref.title}>{ref.title}</span>
  </button>
{/snippet}

{#snippet none()}
  <span class="px-1 text-faint">—</span>
{/snippet}

<div class="flex flex-col gap-0.5 text-2xs">
  <GithubPropertyRow name="Labels">
    <button
      class="flex min-h-6 w-full min-w-0 flex-wrap items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-hover disabled:opacity-50"
      class:bg-hover={editingLabels}
      disabled={github.busy}
      aria-label={editingLabels ? 'Apply label changes' : 'Edit labels'}
      onclick={() => (editingLabels ? closePicker() : openPicker())}
    >
      {#each detail.labels as label (label.name)}
        <GithubLabelPill {label} />
      {:else}
        <span class="text-faint">—</span>
      {/each}
    </button>
  </GithubPropertyRow>
  {#if editingLabels}
    <div class="flex flex-col gap-1.5 pb-1.5">
      <GithubLabelPicker
        selected={chosen}
        disabled={github.busy}
        onchange={(next) => (pending = next)}
      />
      <button
        class="self-start rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
        disabled={github.busy}
        onclick={closePicker}
      >
        {github.busy ? 'Saving…' : 'Apply'}
      </button>
    </div>
  {/if}

  <GithubPropertyRow name="Assignees">
    <GithubMenu label="Change assignees" disabled={github.busy}>
      {#snippet trigger()}
        {#if detail.assignees.length === 1}
          <GithubAvatar actor={detail.assignees[0]} size={16} />
          <span class="truncate text-default">{detail.assignees[0].login}</span>
        {:else if detail.assignees.length > 1}
          <span class="flex items-center -space-x-1" title={assigneeLogins(detail).join(', ')}>
            {#each detail.assignees as assignee (assignee.login)}
              <GithubAvatar actor={assignee} size={16} />
            {/each}
          </span>
        {:else}
          <span class="text-faint">—</span>
        {/if}
      {/snippet}
      <FloatingScrollbar class="max-h-56">
        <div class="flex flex-col">
          {#each github.mentionables as actor (actor.login)}
            <button
              class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
              onclick={() => toggleAssignee(actor.login)}
            >
              <Checkbox size="sm" checked={assigneeLogins(detail).includes(actor.login)} />
              <GithubAvatar {actor} size={14} />
              <span class="truncate">{actor.login}</span>
            </button>
          {/each}
          {#if github.mentionables.length === 0}
            <p class="px-1.5 py-1 text-2xs text-dim">No assignable people.</p>
          {/if}
        </div>
      </FloatingScrollbar>
    </GithubMenu>
  </GithubPropertyRow>

  {#if detail.kind === 'issue'}
    {#each github.issueFields as field (field.id)}
      <GithubIssueFieldSection {field} optionId={fieldValueOf(field.id)} />
    {/each}
    {#if github.dateFields.length > 0}
      <GithubPropertyRow name="Dates">
        <span class="flex min-w-0 items-center gap-0.5">
          {#each github.dateFields as field, index (field.id)}
            {#if index > 0}
              <span class="shrink-0 text-faint">→</span>
            {/if}
            <GithubIssueDateSection {field} date={dateValueOf(field.id)} />
          {/each}
        </span>
      </GithubPropertyRow>
    {/if}
  {/if}

  {#if github.capabilities.issueTypes && detail.kind === 'issue'}
    <GithubPropertyRow name="Type">
      {#if detail.issueType}
        <span class="px-1">
          <GithubLabelPill
            label={{ name: detail.issueType.name, color: issueTypeColour(detail.issueType.color) }}
          />
        </span>
      {:else}
        {@render none()}
      {/if}
    </GithubPropertyRow>
  {/if}

  {#if github.capabilities.projects}
    <GithubPropertyRow name="Projects">
      {#if detail.projects && detail.projects.length > 0}
        <span class="flex min-w-0 flex-col px-1">
          {#each detail.projects as project (project.number)}
            <span class="truncate text-default" title={project.title}>{project.title}</span>
          {/each}
        </span>
      {:else}
        {@render none()}
      {/if}
    </GithubPropertyRow>
  {/if}

  <GithubPropertyRow name="Milestone">
    <GithubMenu label="Change milestone" disabled={github.busy}>
      {#snippet trigger()}
        {#if detail.milestone}
          <span class="truncate text-default" title={milestoneTooltip(detail.milestone)}>
            {detail.milestone.title}
          </span>
        {:else}
          <span class="text-faint">—</span>
        {/if}
      {/snippet}
      {#snippet children(close)}
        <FloatingScrollbar class="max-h-56">
          <div class="flex flex-col">
            <button
              class="rounded px-1.5 py-1 text-left text-2xs text-dim hover:bg-hover"
              onclick={() => {
                close()
                void applyMilestone(null)
              }}
            >
              No milestone
            </button>
            {#each github.milestones as milestone (milestone.number)}
              <button
                class="flex flex-col rounded px-1.5 py-1 text-left text-2xs hover:bg-hover"
                class:text-default={milestone.title === milestoneTitle}
                class:text-dim={milestone.title !== milestoneTitle}
                onclick={() => {
                  close()
                  void applyMilestone(milestone.title)
                }}
              >
                <span class="truncate">{milestone.title}</span>
                {#if milestone.state === 'closed'}
                  <span class="text-[9px] text-dim">closed</span>
                {/if}
              </button>
            {/each}
            {#if github.milestones.length === 0}
              <p class="px-1.5 py-1 text-2xs text-dim">This repository has no milestones.</p>
            {/if}
            <button
              class="mt-1 rounded px-1.5 py-1 text-left text-2xs text-dim hover:bg-hover hover:text-default"
              onclick={() => {
                close()
                creatingMilestone = true
              }}
            >
              New milestone…
            </button>
          </div>
        </FloatingScrollbar>
      {/snippet}
    </GithubMenu>
  </GithubPropertyRow>
  {#if creatingMilestone}
    <div class="pb-1.5">
      <GithubMilestoneForm onclose={() => (creatingMilestone = false)} />
    </div>
  {/if}

  {#if detail.kind === 'pull'}
    <GithubPropertyRow name="Branch">
      <span
        class="truncate px-1 font-mono text-default"
        title="{detail.headRefName} → {detail.baseRefName}"
      >
        {detail.headRefName} → {detail.baseRefName}
      </span>
    </GithubPropertyRow>
  {/if}

  {#if detail.kind === 'issue'}
    <GithubPropertyRow name="Branch">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        {#each linkedBranches as branch (branch)}
          <span class="truncate px-1 font-mono text-default" title={branch}>{branch}</span>
        {/each}
        {#each issueWorktrees as worktree (worktree.id)}
          {@const current = worktree.id === store.selectedWorktreeId}
          <div class="flex min-w-0 items-center gap-1.5 px-1">
            <GitBranchIcon size={11} class="shrink-0 text-dim" />
            <span class="min-w-0 flex-1 truncate font-mono text-default" title={worktree.path}>
              {worktree.name}
            </span>
            {#if current}
              <span class="shrink-0 text-dim">current</span>
            {:else}
              <button
                class="shrink-0 rounded px-1 text-dim hover:bg-hover hover:text-default"
                title="Switch to the worktree {worktree.name}"
                onclick={() => switchToWorktree(worktree)}
              >
                Switch
              </button>
            {/if}
          </div>
        {/each}
        <button
          class="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
          disabled={github.busy}
          title="Create a worktree on {branchNameFor(
            detail.number,
            detail.title
          )}, optionally with an agent briefed on the issue"
          onclick={startWorkOnIssue}
        >
          {#if github.workProgress}
            <WaveSpinner count={3} />
          {:else}
            <GitBranchIcon size={11} />
          {/if}
          {#if github.workProgress === 'worktree'}
            Creating worktree…
          {:else if github.workProgress === 'agent'}
            Starting agent…
          {:else}
            Work on this
          {/if}
        </button>
      </div>
    </GithubPropertyRow>
  {/if}

  {#if showsRelationships}
    <GithubPropertyRow name="Linked">
      {#if detail.parent || subIssueProgress}
        <div class="flex min-w-0 flex-1 flex-col py-0.5">
          {#if detail.parent}
            <span class="px-1 text-dim">Parent</span>
            {@render refRow(detail.parent)}
          {/if}
          {#if subIssueProgress}
            <span class="px-1 text-dim">Sub-issues · {subIssueProgress}</span>
            {#each subIssues as child (child.number)}
              {@render refRow(child)}
            {/each}
          {/if}
        </div>
      {:else}
        {@render none()}
      {/if}
    </GithubPropertyRow>
  {/if}

  <GithubPropertyRow name="People">
    {#if github.participants.length > 0}
      <span class="flex flex-wrap gap-1 px-1">
        {#each github.participants as actor (actor.login)}
          <span title={actor.login}><GithubAvatar {actor} size={16} /></span>
        {/each}
      </span>
    {:else}
      {@render none()}
    {/if}
  </GithubPropertyRow>
</div>
