<script lang="ts">
  import { store, openFileInEditor } from '../lib/store.svelte'
  import { intro } from '../lib/intro.svelte'
  import { INTRO_PHASES, INTRO_PHASE_LABELS } from '../lib/intro/prompt'
  import { diffCounts } from '../lib/intro/introDiff'
  import { layout } from '../lib/layout.svelte'

  let discardExamplesOnFinish = $state(true)

  const counts = $derived(diffCounts(intro.diffRows))
  const phaseIndex = $derived(INTRO_PHASES.indexOf(intro.phase))

  function worktreePath(): string | null {
    const worktree = store.worktrees.find((entry) => entry.id === intro.worktreeId)
    if (worktree) return worktree.path
    return null
  }

  async function startSession(): Promise<void> {
    if (!store.selectedWorktreeId) return
    await intro.start(store.selectedWorktreeId)
  }

  function openExample(relPath: string): void {
    const root = worktreePath()
    if (!intro.worktreeId || !root) return
    openFileInEditor(intro.worktreeId, `${root}/${relPath}`)
  }

  function openAgentsFile(): void {
    const root = worktreePath()
    if (!intro.worktreeId || !root) return
    openFileInEditor(intro.worktreeId, `${root}/AGENTS.md`)
  }
</script>

<div class="h-full overflow-auto p-6">
  <div class="mx-auto max-w-2xl">
    <h1 class="mb-1 text-lg font-semibold tracking-tight">Set up AGENTS.md</h1>
    <p class="mb-4 text-sm text-dim">
      Teach the agent your coding style. It reads this workspace, works through a real issue with
      you, and writes an AGENTS.md that captures the preferences you agree on.
    </p>

    {#if !intro.active}
      <div class="mb-4 rounded-lg border border-line bg-surface p-4">
        <ol class="mb-4 list-decimal space-y-1 pl-5 text-sm">
          <li>The agent explores the workspace and summarizes the conventions it sees.</li>
          <li>You describe an issue you have been dealing with.</li>
          <li>It writes a small example showing how it would approach that issue.</li>
          <li>You comment on its design decisions.</li>
          <li>It encodes your preferences into AGENTS.md — every change is shown as a diff.</li>
        </ol>
        <div class="flex items-center gap-2">
          <button
            class="rounded-md bg-action px-3 py-1.5 text-sm text-action-fg disabled:opacity-50"
            disabled={!store.selectedWorktreeId || intro.starting}
            onclick={startSession}
          >
            {intro.starting ? 'Starting…' : 'Start'}
          </button>
          <button
            class="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-hover"
            onclick={() => intro.dismiss()}
          >
            Not now
          </button>
        </div>
      </div>
    {:else}
      <div class="mb-4 flex flex-wrap items-center gap-1">
        {#each INTRO_PHASES as phase, index (phase)}
          {#if phase !== 'done'}
            <span
              class="rounded-full px-2 py-0.5 text-2xs {index === phaseIndex
                ? 'bg-action text-action-fg'
                : index < phaseIndex
                  ? 'bg-raised text-green'
                  : 'bg-raised text-dim'}"
            >
              {index + 1}. {INTRO_PHASE_LABELS[phase]}
            </span>
          {/if}
        {/each}
      </div>

      <p class="mb-4 text-sm text-dim">
        The conversation runs in the Agent panel. Answer the agent's questions there — this page
        tracks the example files and every AGENTS.md change.
      </p>

      {#if intro.exampleFiles.length > 0}
        <div class="mb-4 rounded-lg border border-line bg-surface p-3">
          <div class="mb-2 text-2xs uppercase tracking-caps text-dim">Example files</div>
          <div class="flex flex-col gap-1">
            {#each intro.exampleFiles as file (file)}
              <button
                class="truncate rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover"
                onclick={() => openExample(file)}
                title="Open in editor"
              >
                {file}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="mb-4 rounded-lg border border-line bg-surface p-3">
        <div class="mb-2 flex items-center gap-2">
          <span class="text-2xs uppercase tracking-caps text-dim">AGENTS.md changes</span>
          {#if intro.diffRows.length > 0}
            <span class="font-mono text-2xs"
              ><span class="text-green">+{counts.added}</span>
              <span class="text-red">−{counts.removed}</span></span
            >
          {/if}
          <span class="ml-auto flex items-center gap-1">
            <button
              class="rounded border border-line px-1.5 py-0.5 text-2xs hover:bg-hover"
              onclick={openAgentsFile}>open ↗</button
            >
            <button
              class="rounded border border-line px-1.5 py-0.5 text-2xs hover:bg-hover {intro.showSinceStart
                ? 'bg-hover'
                : ''}"
              onclick={() => intro.toggleSinceStart()}
              title="Diff against the file as it was when the session started"
            >
              since start
            </button>
            {#if intro.diffRows.length > 0}
              <button
                class="rounded border border-line px-1.5 py-0.5 text-2xs hover:bg-hover"
                onclick={() => intro.markReviewed()}>mark reviewed</button
              >
            {/if}
          </span>
        </div>
        {#if intro.diffRows.length === 0}
          <div class="text-xs text-dim">
            No unreviewed changes. The agent's next AGENTS.md edit shows up here.
          </div>
        {:else}
          <div class="overflow-x-auto rounded bg-raised font-mono text-xs leading-5">
            {#each intro.diffRows as row, index (index)}
              {#if row.kind === 'hunk'}
                <div class="whitespace-pre px-2 text-dim">{row.text}</div>
              {:else if row.kind === 'add'}
                <div class="whitespace-pre bg-green/10 px-2 text-green">+{row.text}</div>
              {:else if row.kind === 'del'}
                <div class="whitespace-pre bg-red/10 px-2 text-red">−{row.text}</div>
              {:else}
                <div class="whitespace-pre px-2">&nbsp;{row.text}</div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-3">
        <button
          class="rounded-md bg-action px-3 py-1.5 text-sm text-action-fg"
          onclick={() => intro.finish(discardExamplesOnFinish)}
        >
          Finish
        </button>
        <label class="flex items-center gap-1.5 text-xs text-dim">
          <input type="checkbox" bind:checked={discardExamplesOnFinish} />
          delete example files
        </label>
        <button
          class="ml-auto rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
          onclick={() => layout.ensurePane('agent')}
        >
          Show agent panel
        </button>
      </div>
    {/if}
  </div>
</div>
