<script lang="ts">
  // Every process in the project. Up and down walk the list, Enter starts or
  // stops the selected one; other keys pass up to Grove.
  import { FloatingScrollbar } from '@neoworks-dev/ui'
  import ProcessRow from './ProcessRow.svelte'
  import { projectState } from './project.svelte'
  import { isLive } from './status'

  const processes = $derived(projectState.project?.processes ?? [])

  /** The list's own keys; everything else is left for Grove. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      projectState.step(event.key === 'ArrowDown' ? 1 : -1)
      event.preventDefault()
      return
    }
    const process = projectState.selectedProcess
    if (event.key !== 'Enter' || !process) return
    projectState.send({ type: isLive(process.status) ? 'stop' : 'start', name: process.name })
    event.preventDefault()
  }
</script>

<div class="min-h-0 flex-1 outline-none" role="listbox" tabindex="0" onkeydown={onKeydown}>
  <FloatingScrollbar class="h-full">
    <div class="flex flex-col gap-px p-1">
      {#each processes as process (process.name)}
        <ProcessRow {process} />
      {/each}
    </div>
  </FloatingScrollbar>
</div>
