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

<div class="flex h-full flex-col overflow-y-auto p-3 text-sm">
  <h1 class="mb-1 text-sm font-semibold tracking-tight">Set up AGENTS.md</h1>

  {#if !intro.active}
    <p class="mb-3 text-xs text-dim">
      Teach the agent your coding style. It reads this workspace, works through a real issue with
      you, and writes an AGENTS.md capturing the preferences you agree on.
    </p>
    <ol class="mb-3 list-decimal space-y-1 pl-4 text-xs text-dim">
      <li>Agent explores the workspace and summarizes conventions.</li>
      <li>You describe an issue you have been dealing with.</li>
      <li>It writes a small example showing its approach.</li>
      <li>You comment on its design decisions.</li>
      <li>It encodes your preferences into AGENTS.md, shown as diffs here.</li>
    </ol>
    <div class="flex items-center gap-2">
      <button
        class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-50"
        disabled={!store.selectedWorktreeId || intro.starting}
        onclick={startSession}
      >
        {intro.starting ? 'Starting…' : 'Start'}
      </button>
      <button
        class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
        onclick={() => intro.dismiss()}
      >
        Not now
      </button>
    </div>
  {:else}
    <div class="mb-3 flex flex-col gap-1">
      {#each INTRO_PHASES as phase, index (phase)}
        {#if phase !== 'done'}
          <div
            class="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs {index === phaseIndex
              ? 'bg-raised font-medium'
              : 'text-dim'}"
          >
            <span
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs {index <
              phaseIndex
                ? 'bg-green/20 text-green'
                : index === phaseIndex
                  ? 'bg-action text-action-fg'
                  : 'bg-raised'}"
            >
              {index < phaseIndex ? '✓' : index + 1}
            </span>
            {INTRO_PHASE_LABELS[phase]}
          </div>
        {/if}
      {/each}
    </div>

    <p class="mb-3 text-2xs text-dim">
      The conversation runs in the Agent panel — answer there. This page tracks example files and
      every AGENTS.md change.
    </p>

    {#if intro.exampleFiles.length > 0}
      <div class="mb-3">
        <div class="mb-1 text-2xs uppercase tracking-caps text-dim">Example files</div>
        <div class="flex flex-col gap-0.5">
          {#each intro.exampleFiles as file (file)}
            <button
              class="truncate rounded px-1.5 py-0.5 text-left font-mono text-2xs hover:bg-hover"
              onclick={() => openExample(file)}
              title="Open in editor"
            >
              {file.split('/').pop()}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="mb-3">
      <div class="mb-1 flex items-center gap-1.5">
        <span class="text-2xs uppercase tracking-caps text-dim">AGENTS.md</span>
        {#if intro.diffRows.length > 0}
          <span class="font-mono text-2xs"
            ><span class="text-green">+{counts.added}</span>
            <span class="text-red">−{counts.removed}</span></span
          >
        {/if}
        <button
          class="ml-auto rounded border border-line px-1 py-0.5 text-2xs hover:bg-hover"
          onclick={openAgentsFile}>open ↗</button
        >
        <button
          class="rounded border border-line px-1 py-0.5 text-2xs hover:bg-hover {intro.showSinceStart
            ? 'bg-hover'
            : ''}"
          onclick={() => intro.toggleSinceStart()}
          title="Diff against the file as it was when the session started"
        >
          all
        </button>
      </div>
      {#if intro.diffRows.length === 0}
        <div class="text-2xs text-dim">No unreviewed changes yet.</div>
      {:else}
        <div class="overflow-x-auto rounded bg-raised font-mono text-2xs leading-4">
          {#each intro.diffRows as row, index (index)}
            {#if row.kind === 'hunk'}
              <div class="whitespace-pre px-1.5 text-dim">{row.text}</div>
            {:else if row.kind === 'add'}
              <div class="whitespace-pre bg-green/10 px-1.5 text-green">+{row.text}</div>
            {:else if row.kind === 'del'}
              <div class="whitespace-pre bg-red/10 px-1.5 text-red">−{row.text}</div>
            {:else}
              <div class="whitespace-pre px-1.5">&nbsp;{row.text}</div>
            {/if}
          {/each}
        </div>
        <button
          class="mt-1 rounded border border-line px-1.5 py-0.5 text-2xs hover:bg-hover"
          onclick={() => intro.markReviewed()}>mark reviewed</button
        >
      {/if}
    </div>

    <div class="mt-auto flex flex-col gap-2 border-t border-line pt-3">
      <label class="flex items-center gap-1.5 text-2xs text-dim">
        <input type="checkbox" bind:checked={discardExamplesOnFinish} />
        delete example files on finish
      </label>
      <div class="flex items-center gap-2">
        <button
          class="rounded-md bg-action px-3 py-1 text-xs text-action-fg"
          onclick={() => intro.finish(discardExamplesOnFinish)}
        >
          Finish
        </button>
        <button
          class="rounded-md border border-line px-2 py-1 text-2xs hover:bg-hover"
          onclick={() => layout.ensurePane('agent')}
        >
          Agent panel
        </button>
      </div>
    </div>
  {/if}
</div>
