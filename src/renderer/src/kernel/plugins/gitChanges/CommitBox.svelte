<script lang="ts">
  // The commit message — a one-line subject and an optional description — and
  // the button that commits what is staged, at the top of the view the way
  // GitLens and VS Code place it. The button names the branch it commits to,
  // so committing into the wrong worktree reads as such before it happens.
  import Button from '@neoworks-dev/ui/Button'
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import { store } from '../../../lib/store.svelte'

  let {
    worktreeId,
    branch,
    stagedCount,
    subject = $bindable(''),
    description = $bindable(''),
    onCommitted
  }: {
    worktreeId: string
    branch: string
    stagedCount: number
    subject?: string
    description?: string
    onCommitted: () => void
  } = $props()

  let busy = $state(false)
  let descriptionField = $state<HTMLTextAreaElement>()

  const ready = $derived(stagedCount > 0 && subject.trim().length > 0)

  /** The subject, and the description under it after a blank line when there is one. */
  function fullMessage(): string {
    const body = description.trim()
    if (body.length === 0) return subject.trim()
    return `${subject.trim()}\n\n${body}`
  }

  /** Commits the staged changes with the message, then clears it. */
  async function commit(): Promise<void> {
    if (!ready || busy) return
    busy = true
    try {
      await window.workbench.git.commit(worktreeId, fullMessage())
      subject = ''
      description = ''
      onCommitted()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  /** Ctrl/Cmd+Enter commits from either field. */
  function commitOnCtrlEnter(event: KeyboardEvent): boolean {
    if (event.key !== 'Enter') return false
    if (!event.ctrlKey && !event.metaKey) return false
    event.preventDefault()
    void commit()
    return true
  }

  /** In the subject, plain Enter moves on to the description: a subject is one line. */
  function onSubjectKeydown(event: KeyboardEvent): void {
    if (commitOnCtrlEnter(event)) return
    if (event.key !== 'Enter') return
    event.preventDefault()
    descriptionField?.focus()
  }

  /** What the button says is missing, or what it will do. */
  function buttonTitle(): string {
    if (stagedCount === 0) return 'Stage changes first'
    if (subject.trim().length === 0) return 'Write a commit message first'
    if (stagedCount === 1) return 'Commit 1 staged file (Ctrl+Enter)'
    return `Commit ${stagedCount} staged files (Ctrl+Enter)`
  }
</script>

<div class="flex flex-col gap-1.5 px-2 pb-2">
  <input
    class="w-full rounded-md border border-line bg-input px-2 py-1 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
    placeholder="Message (Ctrl+Enter to commit)"
    aria-label="Commit message"
    spellcheck="true"
    bind:value={subject}
    disabled={busy}
    onkeydown={onSubjectKeydown}
  />
  <textarea
    bind:this={descriptionField}
    class="field-sizing-content max-h-40 min-h-12 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
    placeholder="Description (optional)"
    aria-label="Commit description"
    bind:value={description}
    disabled={busy}
    onkeydown={commitOnCtrlEnter}
  ></textarea>
  <!-- The design-system Button takes no title, so the tooltip sits on a wrapper. -->
  <span class="block" title={buttonTitle()}>
    <Button
      variant="primary"
      size="sm"
      icon={CheckIcon}
      full
      disabled={!ready || busy}
      onclick={commit}
    >
      <span class="truncate">Commit to {branch}</span>
    </Button>
  </span>
</div>
