<script lang="ts">
  // What the pane says when there is nothing to run, and how to fix that.
  import StackIcon from 'phosphor-svelte/lib/StackIcon'
  import { IconCircle } from '@neoworks-dev/ui'
  import { projectState } from './project.svelte'

  const project = $derived(projectState.project)

  const SAMPLE = [
    'processes:',
    '  db:',
    '    command: docker compose up postgres',
    '  api:',
    '    command: bun run dev',
    '    working_dir: ./api',
    '    depends_on:',
    '      db:',
    '        condition: process_started'
  ].join('\n')
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-dim">
  <IconCircle icon={StackIcon} size="lg" />
  {#if !project?.branch}
    <h2 class="text-sm font-semibold text-default">No worktree open</h2>
  {:else if project.file}
    <h2 class="text-sm font-semibold text-default">No processes</h2>
    <p>{project.file} has nothing to run.</p>
  {:else}
    <h2 class="text-sm font-semibold text-default">No process-compose file</h2>
    <p>Add a process-compose.yaml to this worktree to run its processes here.</p>
    <pre
      class="mt-1 rounded-md border border-line bg-elevated px-3 py-2 text-left font-mono text-2xs leading-relaxed text-muted">{SAMPLE}</pre>
  {/if}
</div>
