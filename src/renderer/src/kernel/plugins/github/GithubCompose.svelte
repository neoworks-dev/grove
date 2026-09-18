<script lang="ts">
  // The new-issue composer: title, body, and the repository's own labels.
  //
  // Labels are grouped by the "prefix:" convention GitHub repositories use
  // (area:, kind:, …) rather than by a list kept here, so a repository that
  // renames or adds a group needs no change in Grove.
  import Button from '@neoworks-dev/ui/Button'
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { github, createIssue, loadLabels } from './store.svelte'
  import type { GithubLabelDefinition } from '../../../../../shared/types'

  $effect(() => {
    void loadLabels()
  })

  const canCreate = $derived(github.draft.title.trim().length > 0 && !github.busy)

  interface LabelGroup {
    /** The prefix without its colon, or null for labels that carry none. */
    name: string | null
    labels: GithubLabelDefinition[]
  }

  const groups = $derived.by<LabelGroup[]>(() => {
    const collected: LabelGroup[] = []
    for (const label of github.labels) {
      const prefix = prefixOf(label.name)
      const existing = collected.find((group) => group.name === prefix)
      if (existing) {
        existing.labels.push(label)
        continue
      }
      collected.push({ name: prefix, labels: [label] })
    }
    // Prefixed groups first and alphabetical; the loose labels close the list.
    collected.sort((a, b) => {
      if (a.name === null) return 1
      if (b.name === null) return -1
      return a.name.localeCompare(b.name)
    })
    return collected
  })

  /** The "area" of "area:git", or null when a label has no prefix. */
  function prefixOf(name: string): string | null {
    const colon = name.indexOf(':')
    if (colon <= 0) return null
    return name.slice(0, colon)
  }

  /** What a group is called above its checkboxes. */
  function groupHeading(group: LabelGroup): string {
    if (group.name === null) return 'labels'
    return group.name
  }

  /**
   * How a label reads under its group heading: grouped ones drop the prefix the
   * heading already carries, ungrouped ones keep their whole name.
   */
  function labelText(group: LabelGroup, name: string): string {
    if (group.name === null) return name
    return name.slice(group.name.length + 1)
  }

  function toggleLabel(name: string): void {
    const labels = github.draft.labels
    if (labels.includes(name)) {
      github.draft.labels = labels.filter((entry) => entry !== name)
      return
    }
    github.draft.labels = [...labels, name]
  }

  function cancel(): void {
    github.composing = false
  }

  /** Cmd/Ctrl+Enter submits, the way the comment box and most issue forms do. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    if (!event.metaKey && !event.ctrlKey) return
    if (!canCreate) return
    event.preventDefault()
    void createIssue()
  }
</script>

<div class="flex h-full min-h-0 flex-col" onkeydown={onKeydown} role="form" tabindex="-1">
  <div class="flex items-center gap-2 border-b border-line px-3 py-2">
    <h2 class="flex-1 text-xs text-default">New issue</h2>
    {#if github.dashboard}
      <span class="text-2xs text-dim">{github.dashboard.repo.nameWithOwner}</span>
    {/if}
  </div>

  <FloatingScrollbar class="min-h-0 flex-1">
    <div class="flex flex-col gap-3 px-3 py-3">
      <input
        class="w-full rounded-md border border-line bg-input px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
        placeholder="Title"
        bind:value={github.draft.title}
      />

      <textarea
        class="min-h-40 w-full resize-y rounded-md border border-line bg-input px-2 py-1.5 font-mono text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
        placeholder="Describe it. Markdown works."
        bind:value={github.draft.body}
      ></textarea>

      {#each groups as group (group.name)}
        <div class="flex flex-col gap-1.5">
          <span class="font-mono text-2xs text-dim">{groupHeading(group)}</span>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            {#each group.labels as label (label.name)}
              <label
                class="flex cursor-pointer items-center gap-1.5 text-2xs text-default"
                title={label.description}
              >
                <Checkbox
                  size="sm"
                  checked={github.draft.labels.includes(label.name)}
                  onchange={() => toggleLabel(label.name)}
                />
                <span
                  class="size-2 shrink-0 rounded-full"
                  style:background-color={`#${label.color}`}
                ></span>
                {labelText(group, label.name)}
              </label>
            {/each}
          </div>
        </div>
      {/each}

      {#if github.labels.length === 0}
        <p class="text-2xs text-dim">No labels on this repository.</p>
      {/if}
    </div>
  </FloatingScrollbar>

  <div class="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
    <Button size="sm" variant="ghost" onclick={cancel}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={!canCreate} onclick={createIssue}>
      {github.busy ? 'Creating…' : 'Create'}
    </Button>
  </div>
</div>
