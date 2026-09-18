<script lang="ts">
  // The second row of the list column: state, then the menus that narrow what
  // is under it. Options come from the data rather than from a list here — the
  // authors are whoever appears on this tab, the labels are the repository's
  // own — so a new contributor or a renamed label needs no change.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubChoiceMenu from './GithubChoiceMenu.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubMenu from './GithubMenu.svelte'
  import {
    github,
    clearFilters,
    filterValues,
    loadLabels,
    loadMilestones,
    toggleFilter
  } from './store.svelte'

  let { setStateFilter }: { setStateFilter: (event: Event) => void } = $props()

  let labelQuery = $state('')

  $effect(() => {
    void loadLabels()
    void loadMilestones()
  })

  // Every menu ticks off the query rather than off state of its own, so typing
  // `label:bug` and picking it from the menu are the same act seen twice.
  const authors = $derived(filterValues('author'))
  const labels = $derived(filterValues('label'))
  const milestones = $derived(filterValues('milestone'))
  const types = $derived(filterValues('type'))
  const projects = $derived(filterValues('project'))

  /** Case-insensitive, because the query is typed by hand and GitHub is too. */
  function ticked(values: string[], value: string): boolean {
    return values.some((entry) => entry.toLowerCase() === value.toLowerCase())
  }

  // Milestones come from the repository, so one nothing is filed against yet is
  // still offered. Types and boards come from the loaded items instead — see
  // `typesOf` in filter.ts for why.
  const milestoneOptions = $derived(github.milestones.map((milestone) => milestone.title))

  const labelOptions = $derived.by(() => {
    const needle = labelQuery.trim().toLowerCase()
    if (needle.length === 0) return github.labels
    return github.labels.filter((label) => label.name.toLowerCase().includes(needle))
  })

  function avatarFor(login: string): string | null {
    if (login === 'ghost' || login.includes('[')) return null
    return `https://github.com/${login}.png`
  }
</script>

<div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
  <select
    class="shrink-0 rounded-md border border-line bg-input px-1 py-0.5 text-2xs text-dim outline-none"
    value={github.stateFilter}
    onchange={setStateFilter}
  >
    <option value="open">Open</option>
    <option value="closed">Closed</option>
    <option value="all">All</option>
  </select>

  <GithubMenu label="Author" count={authors.length}>
    <FloatingScrollbar class="max-h-56">
      <div class="flex flex-col">
        {#each github.authorOptions as login (login)}
          <button
            class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
            onclick={() => toggleFilter('author', login)}
          >
            <Checkbox size="sm" checked={ticked(authors, login)} />
            <GithubAvatar actor={{ login, avatarUrl: avatarFor(login) }} size={14} />
            <span class="truncate">{login}</span>
          </button>
        {/each}
        {#if github.authorOptions.length === 0}
          <p class="px-1.5 py-1 text-2xs text-dim">Nothing loaded yet.</p>
        {/if}
      </div>
    </FloatingScrollbar>
  </GithubMenu>

  <GithubMenu label="Labels" count={labels.length}>
    <input
      class="mb-1 w-full rounded-md border border-line bg-input px-2 py-0.5 text-2xs text-default outline-none placeholder:text-dim focus:border-line-strong"
      placeholder="Filter labels"
      bind:value={labelQuery}
    />
    <FloatingScrollbar class="max-h-56">
      <div class="flex flex-col">
        {#each labelOptions as label (label.name)}
          <button
            class="flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-hover"
            onclick={() => toggleFilter('label', label.name)}
          >
            <Checkbox size="sm" checked={ticked(labels, label.name)} />
            <GithubLabelPill {label} />
          </button>
        {/each}
        {#if labelOptions.length === 0}
          <p class="px-1.5 py-1 text-2xs text-dim">No labels match.</p>
        {/if}
      </div>
    </FloatingScrollbar>
  </GithubMenu>

  <GithubChoiceMenu
    label="Milestone"
    options={milestoneOptions}
    selected={milestones}
    empty="This repository has no milestones."
    ontoggle={(title) => toggleFilter('milestone', title)}
  />

  {#if github.capabilities.issueTypes}
    <GithubChoiceMenu
      label="Type"
      options={github.typeOptions}
      selected={types}
      empty="Nothing here carries a type."
      ontoggle={(name) => toggleFilter('type', name)}
    />
  {/if}

  {#if github.capabilities.projects}
    <GithubChoiceMenu
      label="Projects"
      options={github.projectOptions}
      selected={projects}
      empty="Nothing here is on a board."
      ontoggle={(title) => toggleFilter('project', title)}
    />
  {/if}

  {#if github.filtersActive}
    <button
      class="rounded px-1.5 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
      onclick={clearFilters}
    >
      Clear
    </button>
  {/if}

  <span class="ml-auto shrink-0 text-2xs text-dim">
    {github.items.length} shown
  </span>
</div>
