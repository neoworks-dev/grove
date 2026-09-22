<script lang="ts">
  // The selected commit, beside the graph: its whole message, who made it and
  // when, its parents, and the files it changed — each opens as that change.
  // Creating a branch at the commit happens here too, since it needs a name.
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CommitFileRow from '../gitChanges/CommitFileRow.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import { openCommitFileDiff } from '../../../lib/nvim/revisionDiff'
  import { copyText } from '../gitChanges/refActions'
  import { createBranchAt } from './commitActions'
  import type { CommitSummary, DiffFile } from '../../../../../shared/types'

  let {
    worktreeId,
    commit,
    branchFormOpen = $bindable(false),
    onSelectSha,
    onChanged,
    onClose
  }: {
    worktreeId: string
    commit: CommitSummary
    /** Whether the create-branch form is showing; the row menu opens it. */
    branchFormOpen?: boolean
    onSelectSha: (sha: string) => void
    onChanged: () => void
    onClose: () => void
  } = $props()

  let message = $state('')
  let files = $state<DiffFile[] | null>(null)
  let branchName = $state('')
  let switchToBranch = $state(true)
  let nameInput = $state<HTMLInputElement>()

  // The body is everything after the subject line and the blank line under it.
  const body = $derived(message.split('\n').slice(2).join('\n').trim())

  /** Reads the commit's message and files. */
  async function load(sha: string): Promise<void> {
    files = null
    message = ''
    try {
      const [fullMessage, changed] = await Promise.all([
        window.workbench.git.commitMessage(worktreeId, sha),
        window.workbench.git.commitFiles(worktreeId, sha)
      ])
      if (sha !== commit.sha) return
      message = fullMessage
      files = changed
    } catch (err) {
      store.setError((err as Error).message)
      files = []
    }
  }

  /** Opens one of the commit's files as its change. */
  function openFile(file: DiffFile): void {
    openCommitFileDiff(worktreeId, commit, file)
  }

  /** "1 file changed", "3 files changed". */
  function filesChanged(count: number): string {
    if (count === 1) return '1 file changed'
    return `${count} files changed`
  }

  /** Creates the branch named in the form. */
  async function createBranch(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = branchName.trim()
    if (name.length === 0) return
    if (!(await createBranchAt(worktreeId, commit, name, switchToBranch))) return
    branchName = ''
    branchFormOpen = false
    onChanged()
  }

  $effect(() => {
    void load(commit.sha)
  })

  $effect(() => {
    if (branchFormOpen) nameInput?.focus()
  })
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  <div class="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
    <span class="font-mono text-2xs text-dim">{commit.shortSha}</span>
    <RowAction icon={CopyIcon} title="Copy SHA" onclick={() => copyText(commit.sha)} />
    <span class="flex-1"></span>
    <RowAction icon={XIcon} title="Close" onclick={onClose} />
  </div>

  <FloatingScrollbar class="min-h-0 flex-1">
    <div class="flex flex-col gap-2 px-3 py-2">
      <p class="font-medium break-words text-default">{commit.subject}</p>
      {#if body.length > 0}
        <p class="whitespace-pre-wrap break-words text-muted">{body}</p>
      {/if}
      <p class="text-2xs text-dim">
        {commit.authorName} &lt;{commit.authorEmail}&gt;<br />
        {new Date(commit.date).toLocaleString()}
      </p>
      {#if commit.parents.length > 0}
        <p class="flex flex-wrap items-center gap-1 text-2xs text-dim">
          {#if commit.parents.length > 1}merge of{:else}parent{/if}
          {#each commit.parents as parent (parent)}
            <button
              class="font-mono text-muted hover:text-default hover:underline"
              title="Select this commit"
              onclick={() => onSelectSha(parent)}
            >
              {parent.slice(0, commit.shortSha.length)}
            </button>
          {/each}
        </p>
      {/if}

      {#if branchFormOpen}
        <form class="flex flex-col gap-1 rounded-md bg-raised p-2" onsubmit={createBranch}>
          <label class="text-2xs text-dim" for="graph-branch-name">
            New branch at {commit.shortSha}
          </label>
          <input
            id="graph-branch-name"
            bind:this={nameInput}
            bind:value={branchName}
            class="rounded-sm border border-line bg-input px-1.5 py-0.5 text-xs text-default outline-none focus:border-line-strong"
            placeholder="branch-name"
            spellcheck="false"
            onkeydown={(event) => event.key === 'Escape' && (branchFormOpen = false)}
          />
          <div class="flex items-center gap-2">
            <label class="flex flex-1 items-center gap-1 text-2xs text-muted">
              <input type="checkbox" bind:checked={switchToBranch} />
              Switch to it
            </label>
            <button
              type="button"
              class="rounded-sm px-2 py-0.5 text-2xs text-muted hover:bg-hover"
              onclick={() => (branchFormOpen = false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="rounded-sm bg-action px-2 py-0.5 text-2xs text-action-fg hover:bg-action-hover disabled:opacity-50"
              disabled={branchName.trim().length === 0}
            >
              Create
            </button>
          </div>
        </form>
      {/if}
    </div>

    <div role="tree" class="pb-2">
      {#if files === null}
        <p class="px-3 text-2xs text-dim">Loading…</p>
      {:else}
        <p class="px-3 pb-1 text-2xs text-dim">{filesChanged(files.length)}</p>
        {#each files as file (file.path)}
          <CommitFileRow {file} depth={0} onOpen={openFile} />
        {/each}
      {/if}
    </div>
  </FloatingScrollbar>
</div>
