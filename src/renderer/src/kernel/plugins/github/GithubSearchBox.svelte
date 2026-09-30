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
    type SuggestionSources
  } from './searchSuggestions'

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
    const people = [...github.mentionables.map((actor) => actor.login), ...github.authorOptions]
    const branches: string[] = []
    if (github.dashboard) {
      for (const pull of github.dashboard.pulls) branches.push(pull.headRefName, pull.baseRefName)
    }
    return {
      labels: github.labels.map((label) => label.name),
      people,
      milestones: github.milestones.map((milestone) => milestone.title),
      types: github.typeOptions,
      projects: github.projectOptions,
      branches
    }
  })

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

  /** Arrow keys move through the list, Enter or Tab accepts, Escape closes it. */
  function onKeydown(event: KeyboardEvent): void {
    if (!open) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      highlighted = (highlighted + 1) % suggestions.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      highlighted = (highlighted - 1 + suggestions.length) % suggestions.length
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
    <ul
      id={listId}
      class="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 max-w-[80vw] overflow-auto rounded-md border border-line bg-raised py-0.5 shadow-lg"
      role="listbox"
    >
      {#each suggestions as suggestion, index (suggestion.insert)}
        <li>
          <button
            class="flex w-full items-center px-2 py-1 text-left font-mono text-2xs text-default hover:bg-hover"
            class:bg-hover={index === highlighted}
            role="option"
            aria-selected={index === highlighted}
            onmousedown={(event) => {
              // mousedown, not click: blur would close the list first.
              event.preventDefault()
              accept(suggestion)
            }}
          >
            <span class="truncate">{suggestion.label}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
