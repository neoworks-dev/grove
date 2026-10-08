<script lang="ts">
  // What a process would do, in place of an empty terminal until it has run:
  // its full command, where it runs, what it waits on and its environment.
  import { FloatingScrollbar } from '@neoworks-dev/ui'
  import type { ProcessView } from '../messages'
  import { conditionSuffix } from './status'

  let { process }: { process: ProcessView } = $props()

  const environment = $derived(Object.entries(process.environment))
</script>

<FloatingScrollbar class="min-h-0 flex-1">
  <div class="flex flex-col gap-4 p-3 text-xs">
    {#if process.disabled}
      <p class="text-dim">Disabled in the file: Start all leaves it out, but it can be started on its own.</p>
    {/if}
    <section class="flex flex-col gap-1">
      <h3 class="text-2xs font-semibold text-dim">Command</h3>
      <pre
        class="whitespace-pre-wrap break-all rounded-md bg-raised px-2 py-1.5 font-mono text-2xs text-default">{process.command ||
          '(no command)'}</pre>
    </section>
    <section class="flex flex-col gap-1">
      <h3 class="text-2xs font-semibold text-dim">Working directory</h3>
      <span class="break-all font-mono text-2xs text-default">{process.workingDir}</span>
    </section>
    {#if process.dependsOn.length > 0}
      <section class="flex flex-col gap-1">
        <h3 class="text-2xs font-semibold text-dim">Starts</h3>
        <ul class="flex flex-col gap-0.5 text-2xs text-default">
          {#each process.dependsOn as dependency (dependency.name)}
            <li>after {dependency.name}{conditionSuffix(dependency.condition)}</li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if environment.length > 0}
      <section class="flex flex-col gap-1">
        <h3 class="text-2xs font-semibold text-dim">Environment</h3>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-2xs">
          {#each environment as [name, value] (name)}
            <dt class="text-dim">{name}</dt>
            <dd class="break-all text-default">{value}</dd>
          {/each}
        </dl>
      </section>
    {/if}
  </div>
</FloatingScrollbar>
