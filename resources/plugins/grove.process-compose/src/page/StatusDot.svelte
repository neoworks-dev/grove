<script lang="ts">
  // The mark beside a process: what state it is in, at a glance. A coloured
  // dot for most states; a check mark for a run that succeeded and a cross for
  // one that exited with anything but 0.
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import type { ProcessStatus } from '../runner'
  import { dotClasses } from './status'

  let { status }: { status: ProcessStatus } = $props()
</script>

{#if status === 'completed'}
  <span class="grid size-2 shrink-0 place-items-center text-green" aria-hidden="true">
    <CheckIcon size={11} weight="bold" />
  </span>
{:else if status === 'failed'}
  <span class="grid size-2 shrink-0 place-items-center text-red" aria-hidden="true">
    <XIcon size={11} weight="bold" />
  </span>
{:else}
  <span class="size-2 shrink-0 rounded-full {dotClasses(status)}" aria-hidden="true"></span>
{/if}
