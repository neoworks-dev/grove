<script lang="ts">
  // One row of the search box's list: the value, and what it stands for on
  // GitHub — a person's avatar, a label's colour and description, a milestone's
  // progress and due date — so a pick does not have to be made from bare names.
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon'
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import KanbanIcon from 'phosphor-svelte/lib/KanbanIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import { issueTypeColour } from './filter'
  import type { GithubMilestoneDefinition } from '../../../../../shared/types'
  import { milestoneProgress, milestoneStanding, type SearchSuggestion } from './searchSuggestions'

  let { suggestion }: { suggestion: SearchSuggestion } = $props()

  const detail = $derived(suggestion.detail)

  /** Every issue and pull filed against a milestone, open or closed. */
  function issueCount(milestone: GithubMilestoneDefinition): number {
    return milestone.openIssues + milestone.closedIssues
  }
</script>

{#if detail.kind === 'key' || detail.kind === 'word'}
  <span class="truncate font-mono text-default">{suggestion.label}</span>
  <span class="ml-auto shrink-0 pl-3 text-faint">{detail.description}</span>
{:else if detail.kind === 'person'}
  <GithubAvatar actor={detail.actor} size={16} />
  <span class="truncate text-default">{suggestion.label}</span>
  {#if detail.isViewer && suggestion.label !== '@me'}
    <span class="shrink-0 text-faint">you</span>
  {:else if suggestion.label === '@me' && detail.actor.login !== '@me'}
    <span class="truncate text-faint">{detail.actor.login}</span>
  {/if}
{:else if detail.kind === 'label'}
  <span
    class="mt-1 size-2.5 shrink-0 self-start rounded-full"
    style:background-color="#{detail.label.color.replace('#', '')}"
  ></span>
  <span class="flex min-w-0 flex-col">
    <span class="truncate text-default">{suggestion.label}</span>
    {#if detail.label.description}
      <span class="truncate text-faint">{detail.label.description}</span>
    {/if}
  </span>
{:else if detail.kind === 'milestone'}
  {@const standing = milestoneStanding(detail.milestone, new Date())}
  {@const progress = milestoneProgress(detail.milestone)}
  <FlagIcon size={12} class="mt-0.5 shrink-0 self-start text-dim" />
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="flex items-baseline gap-2">
      <span class="truncate text-default">{suggestion.label}</span>
      {#if standing}
        <span
          class="ml-auto shrink-0"
          class:text-faint={standing !== 'Past due'}
          class:text-error={standing === 'Past due'}
        >
          {standing}
        </span>
      {/if}
    </span>
    {#if detail.milestone.description}
      <span class="truncate text-faint">{detail.milestone.description}</span>
    {/if}
    {#if issueCount(detail.milestone) === 0}
      <span class="text-faint">No issues yet</span>
    {:else}
      <span class="mt-0.5 flex items-center gap-2 text-faint">
        <span class="h-1 flex-1 overflow-hidden rounded-full bg-line">
          <span class="block h-full rounded-full bg-success" style:width="{progress}%"></span>
        </span>
        <span class="shrink-0">
          {progress}% · {detail.milestone.openIssues} open · {detail.milestone.closedIssues} closed
        </span>
      </span>
    {/if}
  </span>
{:else if detail.kind === 'type'}
  <span
    class="size-2.5 shrink-0 rounded-full"
    style:background-color="#{issueTypeColour(detail.issueType.color)}"
  ></span>
  <span class="truncate text-default">{suggestion.label}</span>
{:else if detail.kind === 'project'}
  <KanbanIcon size={12} class="shrink-0 text-dim" />
  <span class="truncate text-default">{suggestion.label}</span>
{:else}
  <GitBranchIcon size={12} class="mt-0.5 shrink-0 self-start text-dim" />
  <span class="flex min-w-0 flex-col">
    <span class="truncate font-mono text-default">{suggestion.label}</span>
    {#if detail.branch.pull}
      <span class="truncate text-faint"
        >#{detail.branch.pull.number} {detail.branch.pull.title}</span
      >
    {:else}
      <span class="text-faint">Base branch</span>
    {/if}
  </span>
{/if}
