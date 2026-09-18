<script lang="ts">
  // The new-issue composer: title, body, and the repository's own labels.
  import Button from '@neoworks-dev/ui/Button'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubLabelPicker from './GithubLabelPicker.svelte'
  import GithubMentionBox from './GithubMentionBox.svelte'
  import { github, createIssue } from './store.svelte'

  const canCreate = $derived(github.draft.title.trim().length > 0 && !github.busy)

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

      <GithubMentionBox
        bind:value={github.draft.body}
        rows={12}
        disabled={github.busy}
        placeholder="Describe it. Markdown works, @ mentions people."
      />

      <div class="flex flex-col gap-1.5">
        <span class="text-2xs text-dim">Labels</span>
        <GithubLabelPicker
          selected={github.draft.labels}
          disabled={github.busy}
          onchange={(next) => (github.draft.labels = next)}
        />
      </div>
    </div>
  </FloatingScrollbar>

  <div class="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
    <Button size="sm" variant="ghost" onclick={cancel}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={!canCreate} onclick={createIssue}>
      {github.busy ? 'Creating…' : 'Create'}
    </Button>
  </div>
</div>
