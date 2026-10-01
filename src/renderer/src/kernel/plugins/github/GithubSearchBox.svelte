<script lang="ts">
  // The list's search box, suggesting as it is typed into the way github.com's
  // does: qualifier names for a bare word, the repository's labels, people,
  // milestones and branches once a key is there. The list sits under the box
  // rather than at the caret, for the reason GithubMentionBox gives.
  import { github, loadLabels, loadMentionables, loadMilestones } from './store.svelte'
  import {
    applySuggestion,
    suggestSearch,
    tokenAt,
    type SearchSuggestion,
    type SearchToken,
    type SuggestionBranch,
    type SuggestionSources
  } from './searchSuggestions'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubSearchSuggestionRow from './GithubSearchSuggestionRow.svelte'
  import type { GithubActor, GithubIssueType } from '../../../../../shared/types'

  let {
    value = $bindable(''),
    placeholder = '',
    title = ''
  }: {
    value?: string
    placeholder?: string
    title?: string
  } = $props()

  const MAX_SUGGESTIONS = 8
  const componentId = $props.id()
  const listId = `${componentId}-suggestions`

  let field = $state<HTMLInputElement | null>(null)
  let token = $state<SearchToken | null>(null)
  let highlighted = $state(0)
  // Escape closes the list for the token it was pressed on; typing on reopens it.
  let dismissed = $state(false)

  // People are whoever the repository could assign plus whoever wrote something
  // loaded here, which covers outside contributors.
  const sources = $derived.by<SuggestionSources>(() => {
    const people = [...github.mentionables]
    for (const login of github.authorOptions) {
      if (people.some((actor) => actor.login === login)) continue
      people.push({ login, avatarUrl: avatarFor(login) })
    }
    return {
      labels: github.labels,
      people,
      viewer: viewerActor(people),
      milestones: github.milestones,
      types: issueTypesOnTab(),
      projects: github.projectOptions,
      branches: branchesOfPulls()
    }
  })

  /**
   * An avatar for someone known only by login: github.com redirects `<login>.png`
   * to it. Bots and the deleted-user placeholder have none to redirect to.
   */
  function avatarFor(login: string): string | null {
    if (login === 'ghost' || login.includes('[')) return null
    return `https://github.com/${login}.png`
  }

  /** The signed-in user as an actor, for the `@me` row; null until it is known. */
  function viewerActor(people: GithubActor[]): GithubActor | null {
    const login = github.viewer
    if (login === null) return null
    const known = people.find((actor) => actor.login === login)
    if (known) return known
    return { login, avatarUrl: avatarFor(login) }
  }

  /** The issue types on the loaded items, once each, with their colours. */
  function issueTypesOnTab(): GithubIssueType[] {
    const types: GithubIssueType[] = []
    for (const item of github.tabItems) {
      if (!item.issueType) continue
      if (types.some((type) => type.name === item.issueType?.name)) continue
      types.push(item.issueType)
    }
    return types.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** The branches the loaded pulls come from, each with its pull, then their bases. */
  function branchesOfPulls(): SuggestionBranch[] {
    if (!github.dashboard) return []
    const pulls = github.dashboard.pulls
    const branches: SuggestionBranch[] = pulls.map((pull) => ({
      name: pull.headRefName,
      pull: { number: pull.number, title: pull.title }
    }))
    for (const pull of pulls) {
      if (branches.some((branch) => branch.name === pull.baseRefName)) continue
      branches.push({ name: pull.baseRefName, pull: null })
    }
    return branches
  }

  const suggestions = $derived.by<SearchSuggestion[]>(() => {
    if (!token) return []
    return suggestSearch(token.text, sources, MAX_SUGGESTIONS)
  })

  const open = $derived(!dismissed && suggestions.length > 0)

  /** Loads what the suggestions are drawn from, the first time the box is used. */
  function loadSources(): void {
    void loadLabels()
    void loadMilestones()
    void loadMentionables()
  }

  /** Re-reads the token under the caret after anything that could have moved it. */
  function syncToken(): void {
    if (!field) return
    const caret = field.selectionStart
    if (caret === null) return
    const next = tokenAt(value, caret)
    // Arrow keys fire keyup too; resetting on those would undo every move.
    if (token && token.start === next.start && token.text === next.text) return
    token = next
    highlighted = 0
    dismissed = false
  }

  /** Writes the suggestion into the query and puts the caret after it. */
  function accept(suggestion: SearchSuggestion): void {
    if (!token || !field) return
    const result = applySuggestion(value, token, suggestion)
    value = result.text
    // The caret has to be placed after Svelte has written the new value back.
    const target = field
    requestAnimationFrame(() => {
      target.focus()
      target.setSelectionRange(result.caret, result.caret)
      syncToken()
    })
  }

  /** Scrolls the highlighted row into the list's view once it has re-rendered. */
  function revealHighlighted(): void {
    requestAnimationFrame(() => {
      const row = document.querySelector(`#${CSS.escape(listId)} [aria-selected="true"]`)
      if (row) row.scrollIntoView({ block: 'nearest' })
    })
  }

  /** Arrow keys move through the list, Enter or Tab accepts, Escape closes it. */
  function onKeydown(event: KeyboardEvent): void {
    if (!open) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      highlighted = (highlighted + 1) % suggestions.length
      revealHighlighted()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length
      revealHighlighted()
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      accept(suggestions[highlighted])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      // Stops the pane from taking Escape as well while the list is what closes.
      event.stopPropagation()
      dismissed = true
    }
  }
</script>

<div class="relative min-w-0 flex-1">
  <input
    bind:this={field}
    bind:value
    class="w-full rounded-md border border-line bg-input px-2 py-0.5 font-mono text-2xs text-default outline-none placeholder:font-sans placeholder:text-xs placeholder:text-dim focus:border-line-strong"
    {placeholder}
    {title}
    spellcheck="false"
    role="combobox"
    aria-expanded={open}
    aria-controls={listId}
    aria-autocomplete="list"
    onfocus={loadSources}
    oninput={syncToken}
    onkeyup={syncToken}
    onclick={syncToken}
    onkeydown={onKeydown}
    onblur={() => (token = null)}
  />

  {#if open}
    <div
      class="absolute left-0 top-full z-20 mt-1 w-80 max-w-[80vw] rounded-md border border-line bg-raised p-1 shadow-lg"
    >
      <FloatingScrollbar class="max-h-80">
        <ul id={listId} role="listbox">
          {#each suggestions as suggestion, index (suggestion.insert)}
            <li>
              <button
                class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs hover:bg-hover"
                class:bg-hover={index === highlighted}
                role="option"
                aria-selected={index === highlighted}
                onmousedown={(event) => {
                  // mousedown, not click: blur would close the list first.
                  event.preventDefault()
                  accept(suggestion)
                }}
              >
                <GithubSearchSuggestionRow {suggestion} />
              </button>
            </li>
          {/each}
        </ul>
      </FloatingScrollbar>
    </div>
  {/if}
</div>
