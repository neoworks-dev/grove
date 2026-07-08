<script lang="ts">
  import { activity } from '../lib/activity.svelte'
</script>

<div class="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-elevated py-2">
  {#each activity.views as view (view.id)}
    {@const Icon = view.icon}
    <button
      class="flex h-9 w-9 items-center justify-center rounded-md {activity.activeView === view.id
        ? 'bg-surface text-default'
        : 'text-dim hover:bg-hover hover:text-default'}"
      title={view.label}
      aria-label={view.label}
      onclick={() => activity.setActive(view.id)}
    >
      <Icon size={20} />
    </button>
  {/each}
</div>
