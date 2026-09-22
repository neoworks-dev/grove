<script lang="ts">
  // The commit message and the button that commits what is staged, at the top
  // of the view the way GitLens and VS Code place it. The button names the
  // branch it commits to, so committing into the wrong worktree reads as such
  // before it happens.
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import { store } from '../../../lib/store.svelte'

  let {
    worktreeId,
    branch,
    stagedCount,
    message = $bindable(''),
    onCommitted
  }: {
    worktreeId: string
    branch: string
    stagedCount: number
    message?: string
    onCommitted: () => void
  } = $props()

  let busy = $state(false)

  const ready = $derived(stagedCount > 0 && message.trim().length > 0)

  /** Commits the staged changes with the message, then clears it. */
  async function commit(): Promise<void> {
    if (!ready || busy) return
    busy = true
    try {
      await window.workbench.git.commit(worktreeId, message)
      message = ''
      onCommitted()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Ctrl/Cmd+Enter commits; plain Enter is a new line in the message. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    void commit()
  }

  /** What the button says is missing, or what it will do. */
  function buttonTitle(): string {
    if (stagedCount === 0) return 'Stage changes first'
    if (message.trim().length === 0) return 'Write a commit message first'
    if (stagedCount === 1) return 'Commit 1 staged file (Ctrl+Enter)'
    return `Commit ${stagedCount} staged files (Ctrl+Enter)`
  }
</script>

<div class="flex flex-col gap-1.5 px-2 pb-2">
  <textarea
    class="field-sizing-content max-h-40 min-h-[3.25rem] w-full resize-none rounded border border-line bg-canvas px-2 py-1.5 text-xs outline-none placeholder:text-faint focus:border-line-strong"
    placeholder="Message (Ctrl+Enter to commit)"
    bind:value={message}
    disabled={busy}
    onkeydown={onKeydown}
  ></textarea>
  <button
    class="flex w-full items-center justify-center gap-1.5 rounded bg-action px-2 py-1 text-xs text-action-fg disabled:opacity-50"
    title={buttonTitle()}
    disabled={!ready || busy}
    onclick={commit}
  >
    <CheckIcon size={12} />
    <span class="truncate">Commit to {branch}</span>
  </button>
</div>
