<script lang="ts">
  // First-run setup wizard. Walks a fresh repo through the things Grove needs
  // before it is useful: workbench.yaml services, a default agent, then AGENTS.md.
  //
  // The AGENTS.md stage renders the existing IntroPane rather than reimplementing
  // it — that flow owns its own agent run, showcase diff and dismissal.
  import { setup, SETUP_STAGE_LABELS } from '../lib/setup.svelte'
  import SetupConfigStage from './setup/SetupConfigStage.svelte'
  import IntroPane from './IntroPane.svelte'

  // Only the stages this repo actually needs are shown, so a repo that already
  // has a workbench.yaml is not walked past finished work.
  const stages = $derived(setup.pendingStages)
  const stageIndex = $derived(stages.indexOf(setup.stage))

  function stepClass(index: number): string {
    if (index < stageIndex) return 'bg-green/20 text-green'
    if (index === stageIndex) return 'bg-action text-action-fg'
    return 'bg-raised'
  }

  function rowClass(index: number): string {
    if (index === stageIndex) return 'bg-raised font-medium'
    return 'text-dim'
  }

  function stepLabel(index: number): string {
    if (index < stageIndex) return '✓'
    return String(index + 1)
  }
</script>

{#if setup.stage === 'agents-md'}
  <!-- The AGENTS.md stage is a full flow of its own; give it the whole pane. -->
  <IntroPane />
{:else}
  <div class="flex h-full flex-col overflow-y-auto p-3 text-sm">
    <h1 class="mb-1 text-sm font-semibold tracking-tight">Set up this workspace</h1>

    <div class="mb-3 flex flex-col gap-1">
      {#each stages as stage, index (stage)}
        <div class="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs {rowClass(index)}">
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs {stepClass(
              index
            )}"
          >
            {stepLabel(index)}
          </span>
          {SETUP_STAGE_LABELS[stage]}
        </div>
      {/each}
    </div>

    {#if setup.stage === 'config'}
      <SetupConfigStage />
    {/if}

    <div class="mt-auto pt-3">
      <button class="text-2xs text-dim hover:underline" onclick={() => setup.dismiss()}>
        Not now
      </button>
    </div>
  </div>
{/if}
