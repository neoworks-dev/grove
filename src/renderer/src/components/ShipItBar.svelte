<script lang="ts">
  // Ship-it action bar for the diff pane: commit staged changes, push + open a
  // PR, merge (via GitHub or locally into the base branch), then archive the
  // worktree. Each step streams its git/gh output into the log area below.
  import { store } from '../lib/store.svelte'
  import type { DiffFile, PrMergeMethod } from '../../../shared/types'

  let {
    worktreeId,
    files,
    onChanged
  }: {
    worktreeId: string
    files: DiffFile[]
    onChanged: () => void
  } = $props()

  let commitMessage = $state('')
  let busy = $state(false)
  let log = $state<string[]>([])
  let mergeMenuOpen = $state(false)

  const stagedCount = $derived(files.filter((file) => file.staged).length)

  const baseBranch = $derived(store.config?.workbench.default_base_branch || 'main')
  const branch = $derived(
    store.worktrees.find((worktree) => worktree.id === worktreeId)?.branch || ''
  )

  function append(line: string): void {
    if (line.trim().length === 0) return
    log = [...log, line]
  }

  // Run a ship-it step with shared busy/error/log handling, then refresh the
  // file list so staged state and the diff reflect the new HEAD.
  async function run(label: string, action: () => Promise<string | void>): Promise<void> {
    if (busy) return
    busy = true
    mergeMenuOpen = false
    append(`$ ${label}`)
    try {
      const output = await action()
      if (typeof output === 'string') append(output)
      onChanged()
    } catch (err) {
      append(`✗ ${(err as Error).message}`)
      store.setError((err as Error).message)
    } finally {
      busy = false
    }
  }

  function commit(): void {
    if (stagedCount === 0) {
      store.setError('Nothing staged to commit')
      return
    }
    if (commitMessage.trim().length === 0) {
      store.setError('Commit message is empty')
      return
    }
    const message = commitMessage
    void run('git commit', async () => {
      const out = await window.workbench.git.commit(worktreeId, message)
      commitMessage = ''
      return out
    })
  }

  function pushAndPr(): void {
    // PR title falls back to the branch name when no fresh commit message is at
    // hand; body is left for the user to fill on GitHub.
    const title = commitMessage.trim().length > 0 ? commitMessage : branch
    void run('git push + gh pr create', async () => {
      const pushed = await window.workbench.git.push(worktreeId)
      append(pushed)
      return window.workbench.github.openPr(worktreeId, { title, body: '', base: baseBranch })
    })
  }

  function mergeGithub(method: PrMergeMethod): void {
    void run(`gh pr merge --${method}`, () =>
      window.workbench.github.mergePr(worktreeId, { method, deleteBranch: true })
    )
  }

  function mergeLocal(): void {
    void run(`git merge ${branch} → ${baseBranch}`, () =>
      window.workbench.git.mergeLocal(worktreeId, baseBranch)
    )
  }

  function archive(): void {
    void run('archive worktree', () =>
      window.workbench.worktrees.archive(worktreeId, { deleteBranch: true, force: false })
    )
  }
</script>

<div class="border-t border-line px-3 py-2">
  <div class="mb-2 flex items-center gap-1">
    <input
      class="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-line-strong"
      placeholder="Commit message"
      bind:value={commitMessage}
      disabled={busy}
      onkeydown={(event) => event.key === 'Enter' && commit()}
    />
    <button
      class="shrink-0 rounded bg-action px-2 py-1 text-2xs text-action-fg disabled:opacity-50"
      onclick={commit}
      disabled={busy || stagedCount === 0}
      title={stagedCount === 0 ? 'Stage files first' : `Commit ${stagedCount} staged`}
    >
      Commit
    </button>
  </div>

  <div class="flex items-center gap-1">
    <button
      class="rounded border border-line px-2 py-1 text-2xs hover:bg-hover disabled:opacity-50"
      onclick={pushAndPr}
      disabled={busy}
    >
      Push + PR
    </button>

    <div class="relative">
      <button
        class="rounded border border-line px-2 py-1 text-2xs hover:bg-hover disabled:opacity-50"
        onclick={() => (mergeMenuOpen = !mergeMenuOpen)}
        disabled={busy}
      >
        Merge ▾
      </button>
      {#if mergeMenuOpen}
        <div
          class="absolute bottom-full left-0 z-10 mb-1 w-44 rounded border border-line bg-raised py-1 shadow-lg"
        >
          <button
            class="block w-full px-2 py-1 text-left text-2xs hover:bg-hover"
            onclick={() => mergeGithub('squash')}
          >
            via GitHub (squash)
          </button>
          <button
            class="block w-full px-2 py-1 text-left text-2xs hover:bg-hover"
            onclick={mergeLocal}
          >
            Local → {baseBranch}
          </button>
        </div>
      {/if}
    </div>

    <button
      class="ml-auto rounded border border-line px-2 py-1 text-2xs text-red hover:bg-hover disabled:opacity-50"
      onclick={archive}
      disabled={busy}
      title="Remove worktree and delete its branch"
    >
      Archive
    </button>
  </div>

  {#if log.length > 0}
    <div class="mt-2 max-h-24 overflow-auto rounded bg-canvas p-1.5 font-mono text-2xs text-dim">
      {#each log as line, index (index)}
        <div class="whitespace-pre-wrap break-words">{line}</div>
      {/each}
    </div>
  {/if}
</div>
