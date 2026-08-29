<script lang="ts">
  // Config stage of the setup wizard: review the services the detectors found,
  // edit them, and write the chosen ones into workbench.yaml.
  import { setup } from '../../../lib/setup.svelte'

  const selectedCount = $derived(setup.selected.size)
</script>

<p class="mb-3 text-xs text-dim">
  Grove found these long-running processes in your repo. Pick the ones it should supervise per
  worktree — edit any of them here, and change everything later in <code>workbench.yaml</code>.
</p>

{#if setup.detecting}
  <p class="mb-3 text-xs text-dim">Scanning…</p>
{:else if setup.detectedNothing}
  <div class="mb-3 flex flex-col gap-1 rounded border border-line p-2">
    <p class="text-2xs text-dim">
      Nothing detected. Grove looks at package.json scripts, Docker Compose, Procfile and Makefile
      targets.
    </p>
    <p class="text-2xs text-dim">
      Skip this and add services to <code>workbench.yaml</code> by hand.
    </p>
  </div>
{:else}
  <div class="mb-3 flex flex-col gap-1.5">
    {#each setup.proposals as proposal (proposal.name)}
      <div class="rounded border border-line p-1.5">
        <label class="flex items-start gap-1.5">
          <input
            type="checkbox"
            class="mt-1"
            checked={setup.selected.has(proposal.name)}
            onchange={() => setup.toggle(proposal.name)}
          />
          <span class="flex min-w-0 grow flex-col gap-1">
            <span class="flex items-center gap-1.5">
              <span class="text-xs font-medium">{proposal.name}</span>
              <span class="text-2xs text-dim">{proposal.source}</span>
            </span>
            <input
              class="w-full rounded bg-input px-1 py-0.5 font-mono text-2xs"
              value={proposal.command}
              oninput={(event) =>
                setup.update(proposal.name, { command: event.currentTarget.value })}
            />
            {#if !proposal.usesPort}
              <span
                class="text-2xs text-amber"
                title="This service ignores the worktree port block"
              >
                fixed port — parallel worktrees will collide
              </span>
            {/if}
          </span>
        </label>
      </div>
    {/each}
  </div>
{/if}

{#if setup.error}
  <p class="mb-2 text-2xs text-red">{setup.error}</p>
{/if}

<div class="flex items-center gap-2">
  <button
    class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-50"
    disabled={setup.writing || selectedCount === 0}
    onclick={() => setup.writeConfig()}
  >
    {#if setup.writing}Writing…{:else}Write workbench.yaml ({selectedCount}){/if}
  </button>
  <button
    class="rounded-md border border-line px-2 py-1 text-2xs hover:bg-hover"
    onclick={() => setup.skip()}
  >
    Skip
  </button>
  <button
    class="rounded-md border border-line px-2 py-1 text-2xs hover:bg-hover disabled:opacity-50"
    disabled={setup.detecting}
    onclick={() => setup.detect()}
  >
    Rescan
  </button>
</div>
