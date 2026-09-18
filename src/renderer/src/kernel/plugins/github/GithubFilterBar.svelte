<script lang="ts">
  // The second row of the list column: state, then the menus that narrow what
  // is under it. Options come from the data rather than from a list here — the
  // authors are whoever appears on this tab, the labels are the repository's
  // own — so a new contributor or a renamed label needs no change.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubMenu from './GithubMenu.svelte'
  import { github, clearFilters, loadLabels } from './store.svelte'

  let { setStateFilter }: { setStateFilter: (event: Event) => void } = $props()

  let labelQuery = $state('')

  $effect(() => {
    void loadLabels()
  })

  const labelOptions = $derived.by(() => {
    const needle = labelQuery.trim().toLowerCase()
    if (needle.length === 0) return github.labels
    return github.labels.filter((label) => label.name.toLowerCase().includes(needle))
  })

  function toggleAuthor(login: string): void {
    if (github.authorFilter.includes(login)) {
      github.authorFilter = github.authorFilter.filter((entry) => entry !== login)
      return
    }
    github.authorFilter = [...github.authorFilter, login]
  }

  function toggleLabel(name: string): void {
    if (github.labelFilter.includes(name)) {
      github.labelFilter = github.labelFilter.filter((entry) => entry !== name)
      return
    }
    github.labelFilter = [...github.labelFilter, name]
  }

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

  <GithubMenu label="Author" count={github.authorFilter.length}>
    <FloatingScrollbar class="max-h-56">
      <div class="flex flex-col">
        {#each github.authorOptions as login (login)}
          <button
            class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
            onclick={() => toggleAuthor(login)}
          >
            <Checkbox size="sm" checked={github.authorFilter.includes(login)} />
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

  <GithubMenu label="Labels" count={github.labelFilter.length}>
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
            onclick={() => toggleLabel(label.name)}
          >
            <Checkbox size="sm" checked={github.labelFilter.includes(label.name)} />
            <GithubLabelPill {label} />
          </button>
        {/each}
        {#if labelOptions.length === 0}
          <p class="px-1.5 py-1 text-2xs text-dim">No labels match.</p>
        {/if}
      </div>
    </FloatingScrollbar>
  </GithubMenu>

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
