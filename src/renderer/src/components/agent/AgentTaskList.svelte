<script lang="ts">
  import WaveSpinner from '../WaveSpinner.svelte'
  import type { TaskItem } from '../../lib/agent/tasks'

  let { tasks, open = $bindable(true) }: { tasks: TaskItem[]; open?: boolean } = $props()

  const done = $derived(tasks.filter((task) => task.status === 'completed').length)
  const activeLabel = $derived(
    tasks.find((task) => task.status === 'in_progress')?.activeForm || ''
  )
</script>

<div class="shrink-0 border-t border-line bg-elevated px-2 py-1.5">
  <button
    class="flex w-full items-center gap-2 px-1 text-2xs uppercase tracking-caps text-dim"
    onclick={() => (open = !open)}
  >
    <span>{open ? '▾' : '▸'} Tasks · {done}/{tasks.length}</span>
    {#if !open && activeLabel}
      <span class="truncate normal-case tracking-normal text-muted">{activeLabel}</span>
    {/if}
  </button>
  {#if open}
    <div class="mt-1 flex max-h-40 flex-col gap-0.5 overflow-auto">
      {#each tasks as task (task.id)}
        <div class="flex items-center gap-2 px-2 py-0.5 text-2xs">
          {#if task.status === 'completed'}
            <span class="shrink-0 text-dim">✓</span>
          {:else if task.status === 'in_progress'}
            <span class="shrink-0 text-green"><WaveSpinner /></span>
          {:else}
            <span class="shrink-0 text-dim">○</span>
          {/if}
          <span
            class="truncate {task.status === 'completed' ? 'text-dim line-through' : 'text-muted'}"
          >
            {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
