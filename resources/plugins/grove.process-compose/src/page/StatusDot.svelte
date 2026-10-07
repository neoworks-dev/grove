<script lang="ts">
  // The coloured dot beside a process: what state it is in, at a glance.
  import type { ProcessStatus } from '../runner'
  import { dotClasses } from './status'

  let { status }: { status: ProcessStatus } = $props()
</script>

<span class="size-2 shrink-0 rounded-full {dotClasses(status)}" aria-hidden="true"></span>
