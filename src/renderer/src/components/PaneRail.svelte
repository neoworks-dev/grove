<script lang="ts">
  // Pane rail — the right-hand counterpart of the ActivityBar. Lists every pane
  // a user can open by name that the left rail doesn't already carry, so a
  // plugin's pane shows up here the moment it registers. Clicking toggles it.
  import AppWindowIcon from 'phosphor-svelte/lib/AppWindowIcon'
  import { panes } from '../lib/panes.svelte'
  import { layout } from '../lib/layout.svelte'

  const launchable = $derived(panes.openableTypes().filter((type) => !type.rail))
</script>

<div class="flex w-9 shrink-0 flex-col items-center gap-1 py-2">
  {#each launchable as type (type.id)}
    {@const PaneIcon = type.icon || AppWindowIcon}
    {@const open = layout.hasPaneType(type.id)}
    <button
      class="flex h-8 w-8 items-center justify-center rounded-md"
      class:bg-raised={open}
      class:text-default={open}
      class:text-dim={!open}
      class:hover:bg-hover={!open}
      class:hover:text-default={!open}
      title={type.title}
      aria-label={type.title}
      onclick={() => layout.togglePane(type.id)}
    >
      <PaneIcon size={18} />
    </button>
  {/each}
</div>
