<script lang="ts">
  import WaveSpinner from '../WaveSpinner.svelte'

  let { message, tokensLabel }: { message: string; tokensLabel: string } = $props()
</script>

<!-- Working-state bar: live indicator, funny status, token count. -->
<div class="flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-3 py-1.5 text-2xs">
  <span class="shrink-0 text-green"><WaveSpinner /></span>
  <span class="truncate italic text-muted">{message}</span>
  <span
    class="ml-auto shrink-0 font-mono text-muted"
    title="context window fill + output of the latest turn">{tokensLabel} tok</span
  >
</div>
