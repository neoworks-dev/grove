<script lang="ts">
  // Rewind, in place of the transcript: the prompts sent in this session, and what
  // going back to one of them puts back. Plain on purpose; the agent pane's menus
  // get a design pass of their own.

  import Button from '@neoworks-dev/ui/Button'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import {
    RESTORE_CODE_WARNING,
    rewindAvailability,
    type RewindChoice
  } from '../../../../lib/agents/rewind'
  import type { UserItem } from '../../../../lib/agents/transcript'
  import type { RewindSnapshot } from '../../../../../../shared/agents'
  import type { TreeFileChange } from '../../../../../../shared/types'

  let {
    sessionId,
    prompts,
    harnessRewinds,
    running,
    onRestore,
    onClose
  }: {
    sessionId: string
    /** The prompts that can be rewound to, oldest first. */
    prompts: UserItem[]
    harnessRewinds: boolean
    running: boolean
    /** Carries out a choice; resolves to what went wrong, or null when it worked. */
    onRestore: (choice: RewindChoice, prompt: UserItem) => Promise<string | null>
    onClose: () => void
  } = $props()

  const MAX_FILES_LISTED = 8

  const newestFirst = $derived([...prompts].reverse())
  let selectedSeq = $state<number | null>(null)
  let snapshots = $state<RewindSnapshot[]>([])
  let changes = $state<TreeFileChange[] | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const selected = $derived.by(() => {
    const found = newestFirst.find((prompt) => prompt.seq === selectedSeq)
    if (found === undefined) return null
    return found
  })
  const hasSnapshot = $derived(snapshots.some((snapshot) => snapshot.promptSeq === selectedSeq))
  const changedFileCount = $derived.by(() => {
    if (changes === null) return 0
    return changes.length
  })
  const availability = $derived(
    rewindAvailability({ harnessRewinds, running, hasSnapshot, changedFileCount })
  )

  // The newest prompt is the likeliest to be wanted, so it starts chosen.
  $effect(() => {
    if (selectedSeq === null && newestFirst.length > 0) selectedSeq = newestFirst[0].seq
  })

  $effect(() => {
    void window.workbench.rewind
      .snapshots(sessionId)
      .then((found) => (snapshots = found))
      .catch((cause: unknown) => (error = (cause as Error).message))
  })

  // What a restore of the chosen prompt would change, read again as the choice moves.
  $effect(() => {
    const seq = selectedSeq
    changes = null
    if (seq === null || !hasSnapshot) return
    void window.workbench.rewind
      .changes(sessionId, seq)
      .then((found) => {
        if (selectedSeq === seq) changes = found
      })
      .catch((cause: unknown) => (error = (cause as Error).message))
  })

  /** A prompt's first line, for its row. */
  function firstLine(prompt: UserItem): string {
    const line = prompt.text.split('\n').find((candidate) => candidate.trim().length > 0)
    if (line === undefined) return '(no text)'
    return line
  }

  /** Moves the highlighted prompt up or down the list. */
  function step(direction: number): void {
    if (newestFirst.length === 0) return
    const current = newestFirst.findIndex((prompt) => prompt.seq === selectedSeq)
    const next = Math.min(newestFirst.length - 1, Math.max(0, current + direction))
    selectedSeq = newestFirst[next].seq
  }

  let optionsEl = $state<HTMLDivElement>()

  /** Moves the keyboard to the first choice that is open, so Enter then carries it out. */
  function focusFirstChoice(): void {
    optionsEl?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }

  /** Arrow keys move through the prompts, Enter steps into the choices, Escape backs out. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault()
      focusFirstChoice()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    }
  }

  /** Carries out a choice for the chosen prompt, and returns to the conversation when it worked. */
  async function choose(choice: RewindChoice): Promise<void> {
    if (!selected || busy) return
    busy = true
    error = null
    const problem = await onRestore(choice, selected)
    busy = false
    if (problem === null) {
      onClose()
      return
    }
    error = problem
  }

  /** Puts keyboard focus in the pane, so its keys work as it opens. */
  function takeFocus(element: HTMLElement): void {
    element.focus()
  }

  const listedFiles = $derived.by(() => {
    if (changes === null) return []
    return changes.slice(0, MAX_FILES_LISTED)
  })
  const hiddenFiles = $derived(Math.max(0, changedFileCount - MAX_FILES_LISTED))
</script>

<!-- Replaces the transcript: the composer stays under it, and Esc or "Never mind" brings the conversation back. -->
<div
  class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 outline-none"
  role="application"
  aria-label="Rewind"
  tabindex="-1"
  use:takeFocus
  onkeydown={onKeydown}
>
  <div class="text-xs font-medium text-default">Rewind to a prompt</div>
  <p class="text-2xs text-dim">
    Pick the prompt to go back to. Up and down to move, Enter to choose, Esc to leave.
  </p>

  {#if newestFirst.length === 0}
    <p class="text-2xs text-dim">No prompts have been sent in this session yet.</p>
  {:else}
    <div class="shrink-0 overflow-hidden rounded border border-line">
      <FloatingScrollbar class="max-h-44">
        {#each newestFirst as prompt (prompt.seq)}
          <button
            class="block w-full truncate px-2 py-1.5 text-left text-xs {prompt.seq === selectedSeq
              ? 'bg-action text-action-fg'
              : 'text-muted hover:bg-hover'}"
            tabindex="-1"
            onclick={() => (selectedSeq = prompt.seq)}
          >
            {firstLine(prompt)}
          </button>
        {/each}
      </FloatingScrollbar>
    </div>
  {/if}

  {#if selected}
    <div bind:this={optionsEl} class="flex flex-col gap-2" data-testid="rewind-options">
      {#if availability.code && changes}
        <p
          class="rounded border border-amber/30 bg-amber-soft px-2 py-1.5 text-2xs text-amber"
          data-testid="rewind-warning"
        >
          {RESTORE_CODE_WARNING}
        </p>
        <div class="text-2xs text-dim" data-testid="rewind-files">
          <div>
            {changes.length} file{changes.length === 1 ? '' : 's'} would change:
          </div>
          {#each listedFiles as file (file.path)}
            <div class="truncate font-mono text-default">{file.path}</div>
          {/each}
          {#if hiddenFiles > 0}
            <div>and {hiddenFiles} more</div>
          {/if}
        </div>
      {/if}

      <div class="flex flex-col items-stretch gap-1.5">
        <Button
          size="sm"
          full
          disabled={busy || !availability.both}
          onclick={() => void choose('both')}
        >
          Restore code and conversation
        </Button>
        <Button
          size="sm"
          full
          disabled={busy || !availability.conversation}
          onclick={() => void choose('conversation')}
        >
          Restore conversation
        </Button>
        <Button
          size="sm"
          full
          disabled={busy || !availability.code}
          onclick={() => void choose('code')}
        >
          Restore code
        </Button>
        <Button size="sm" full variant="ghost" onclick={onClose}>Never mind</Button>
      </div>

      {#if availability.conversationReason}
        <p class="text-2xs text-dim">Conversation: {availability.conversationReason}</p>
      {/if}
      {#if availability.codeReason}
        <p class="text-2xs text-dim">Code: {availability.codeReason}</p>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="text-2xs text-red">{error}</p>
  {/if}
</div>
