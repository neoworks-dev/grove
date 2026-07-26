<script lang="ts">
  // Agent stage of the setup wizard: pick the agent Grove opens by default.
  // The list comes from the host rather than a literal here, so an adapter
  // added later shows up without touching this component.
  import { store } from '../../lib/store.svelte'
  import { setup } from '../../lib/setup.svelte'
  import { settings } from '../../lib/settings.svelte'

  const agentNames = $derived(Object.keys(store.agentConfigs))
  const current = $derived(settings.get<string>('workbench.defaultAgent') || '')
</script>

<p class="mb-3 text-xs text-dim">
  Which agent should Grove open by default? Every worktree can still run any of them, and you can
  change this in Preferences.
</p>

{#if agentNames.length === 0}
  <p class="mb-3 text-2xs text-dim">No agents available.</p>
{:else}
  <div class="mb-3 flex flex-col gap-1">
    {#each agentNames as name (name)}
      <button
        class="flex items-center gap-2 rounded border border-line px-2 py-1 text-left text-xs hover:bg-hover {current ===
        name
          ? 'bg-raised'
          : ''}"
        onclick={() => setup.chooseAgent(name)}
      >
        <span class="font-medium">{name}</span>
        {#if store.agentConfigs[name]?.interactive}
          <span class="ml-auto text-2xs text-dim" title="Supports live permission prompts">
            interactive
          </span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<button
  class="rounded-md border border-line px-2 py-1 text-2xs hover:bg-hover"
  onclick={() => setup.skip()}
>
  Skip
</button>
