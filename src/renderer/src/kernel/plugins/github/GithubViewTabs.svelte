<script lang="ts">
  // The issue list's saved views, as a row of tabs: "All issues" first, then
  // every view saved for this repository, then a way to save what is on screen
  // as a new one. The tab whose view matches what the pane shows is lit.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import { DEFAULT_QUERY } from './search'
  import { viewMatches, type ViewState } from './views'
  import { applyView, deleteView, github, loadSavedViews, saveCurrentView } from './store.svelte'
  import { store } from '../../../lib/store.svelte'

  const ALL_ISSUES: ViewState = { query: DEFAULT_QUERY, layout: 'list', fieldId: null }

  let naming = $state(false)
  let name = $state('')

  // Views belong to the repository, so a different one opening reads its own.
  $effect(() => {
    void store.repo
    loadSavedViews()
  })

  const current = $derived(github.viewState)

  /** Starts naming a new view of what is on screen. */
  function startNaming(): void {
    name = ''
    naming = true
  }

  /**
   * Saves the view under the typed name, or gives up on an empty one. Enter
   * gets here first and the box's blur right after, so only the first counts.
   */
  function finishNaming(): void {
    if (!naming) return
    naming = false
    if (name.trim().length > 0) saveCurrentView(name)
  }

  /** The list's grouping as the select's value: a field id, or empty for none. */
  function listFieldValue(): string {
    if (github.listFieldId === null) return ''
    return github.listFieldId
  }

  /** Groups the list by the picked field, or not at all for the empty choice. */
  function setListField(value: string): void {
    if (value === '') {
      github.listFieldId = null
      return
    }
    github.listFieldId = value
  }

  function onNameKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      finishNaming()
      return
    }
    if (event.key === 'Escape') naming = false
  }

  /** Focuses the name box as soon as it appears. */
  function focusOnMount(element: HTMLInputElement): void {
    element.focus()
  }
</script>

<div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
  <!-- The tabs scroll sideways when there are more than fit, without a bar;
       the grouping stays pinned at the end. -->
  <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
    <button
      class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-2xs hover:bg-hover"
      class:bg-hover={viewMatches(ALL_ISSUES, current)}
      class:text-default={viewMatches(ALL_ISSUES, current)}
      class:text-dim={!viewMatches(ALL_ISSUES, current)}
      onclick={() => applyView(ALL_ISSUES)}
    >
      All issues
    </button>

    {#each github.savedViews as view (view.id)}
      {@const active = viewMatches(view, current)}
      <span
        class="group flex shrink-0 items-center rounded-md hover:bg-hover"
        class:bg-hover={active}
      >
        <button
          class="cursor-pointer py-0.5 pl-1.5 pr-1 text-2xs"
          class:text-default={active}
          class:text-dim={!active}
          title="{view.query} · {view.layout}"
          onclick={() => applyView(view)}
        >
          {view.name}
        </button>
        <button
          class="mr-0.5 hidden cursor-pointer rounded p-0.5 text-dim hover:text-default group-hover:block"
          title="Delete the view {view.name}"
          aria-label="Delete the view {view.name}"
          onclick={() => deleteView(view.id)}
        >
          <XIcon size={9} />
        </button>
      </span>
    {/each}

    {#if naming}
      <input
        class="w-32 shrink-0 rounded-md border border-line bg-input px-1.5 py-0.5 text-2xs text-default outline-none placeholder:text-dim focus:border-line-strong"
        placeholder="Name this view"
        bind:value={name}
        onkeydown={onNameKey}
        onblur={finishNaming}
        use:focusOnMount
      />
    {:else}
      <button
        class="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
        title="Save what is shown as a view"
        onclick={startNaming}
      >
        <PlusIcon size={10} />
        Save view
      </button>
    {/if}
  </div>

  <!-- How the issues are grouped, part of what a view saves; at the row's end,
       where Linear keeps its display options. -->
  {#if github.boardShown && github.boardField}
    <select
      class="shrink-0 rounded-md border border-line bg-input px-1 py-0.5 text-2xs text-dim outline-none"
      title="Group the board by"
      value={github.boardField.id}
      onchange={(event) => (github.boardFieldId = event.currentTarget.value)}
    >
      {#each github.issueFields as field (field.id)}
        <option value={field.id}>{field.name}</option>
      {/each}
    </select>
  {:else if github.tab === 'issue' && github.view === 'list' && github.issueFields.length > 0}
    <select
      class="shrink-0 rounded-md border border-line bg-input px-1 py-0.5 text-2xs text-dim outline-none"
      title="Group the list by"
      value={listFieldValue()}
      onchange={(event) => setListField(event.currentTarget.value)}
    >
      <option value="">No grouping</option>
      {#each github.issueFields as field (field.id)}
        <option value={field.id}>{field.name}</option>
      {/each}
    </select>
  {/if}
</div>
