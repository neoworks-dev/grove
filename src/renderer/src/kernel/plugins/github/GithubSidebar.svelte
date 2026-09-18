<script lang="ts">
  // The item's metadata, as GitHub's right-hand rail: what it carries, with the
  // parts Grove can change editable in place.
  //
  // Type and Projects are read-only and only appear at all when the token could
  // be asked for them — see `fetchCapabilities` in githubDashboard.ts. Drawing
  // an empty "Projects" section for someone who never granted `read:project`
  // would report an absence that was never measured.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GearIcon from 'phosphor-svelte/lib/GearIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubLabelPicker from './GithubLabelPicker.svelte'
  import GithubMenu from './GithubMenu.svelte'
  import { issueTypeColour } from './filter'
  import {
    github,
    applyAssignees,
    applyLabels,
    applyMilestone,
    loadMentionables,
    loadMilestones
  } from './store.svelte'
  import type { GithubItemDetail } from '../../../../../shared/types'

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
    if (detail.assignees.includes(login)) {
      await applyAssignees(detail.assignees.filter((entry) => entry !== login))
      return
    }
    await applyAssignees([...detail.assignees, login])
  }

  /** A milestone's due date as a short line, or null when it has none. */
  function dueLabel(dueOn: string | null): string | null {
    if (dueOn === null) return null
    return `Due ${new Date(dueOn).toLocaleDateString()}`
  }
</script>

<div class="flex flex-col gap-4 text-2xs">
  <section class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-default">Labels</h3>
      <button
        class="rounded p-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
        disabled={github.busy}
        title={editingLabels ? 'Done' : 'Edit labels'}
        aria-label={editingLabels ? 'Apply label changes' : 'Edit labels'}
        onclick={() => (editingLabels ? closePicker() : openPicker())}
      >
        <GearIcon size={12} />
      </button>
    </div>

    {#if editingLabels}
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
    {:else if detail.labels.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each detail.labels as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
      </div>
    {:else}
      <p class="text-dim">None yet</p>
    {/if}
  </section>

  <section class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-default">Assignees</h3>
      <GithubMenu label="Edit" align="right" disabled={github.busy}>
        <FloatingScrollbar class="max-h-56">
          <div class="flex flex-col">
            {#each github.mentionables as actor (actor.login)}
              <button
                class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
                onclick={() => toggleAssignee(actor.login)}
              >
                <Checkbox size="sm" checked={detail.assignees.includes(actor.login)} />
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
    </div>
    {#if detail.assignees.length > 0}
      <p class="text-dim">{detail.assignees.join(', ')}</p>
    {:else}
      <p class="text-dim">No one</p>
    {/if}
  </section>

  {#if github.capabilities.issueTypes && detail.kind === 'issue'}
    <section class="flex flex-col gap-1.5">
      <h3 class="font-medium text-default">Type</h3>
      {#if detail.issueType}
        <div class="flex">
          <GithubLabelPill
            label={{ name: detail.issueType.name, color: issueTypeColour(detail.issueType.color) }}
          />
        </div>
      {:else}
        <p class="text-dim">None yet</p>
      {/if}
    </section>
  {/if}

  {#if github.capabilities.projects}
    <section class="flex flex-col gap-1.5">
      <h3 class="font-medium text-default">Projects</h3>
      {#if detail.projects && detail.projects.length > 0}
        {#each detail.projects as project (project.number)}
          <p class="truncate text-dim" title={project.title}>{project.title}</p>
        {/each}
      {:else}
        <p class="text-dim">None yet</p>
      {/if}
    </section>
  {/if}

  <section class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-default">Milestone</h3>
      <GithubMenu label="Edit" align="right" disabled={github.busy}>
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
            </div>
          </FloatingScrollbar>
        {/snippet}
      </GithubMenu>
    </div>
    {#if detail.milestone}
      <p class="truncate text-dim" title={detail.milestone.title}>{detail.milestone.title}</p>
      {#if dueLabel(detail.milestone.dueOn)}
        <p class="text-[9px] text-dim">{dueLabel(detail.milestone.dueOn)}</p>
      {/if}
    {:else}
      <p class="text-dim">None yet</p>
    {/if}
  </section>

  {#if detail.kind === 'pull'}
    <section class="flex flex-col gap-1.5">
      <h3 class="font-medium text-default">Branch</h3>
      <p class="truncate font-mono text-dim" title="{detail.headRefName} → {detail.baseRefName}">
        {detail.headRefName} → {detail.baseRefName}
      </p>
    </section>
  {/if}
</div>
