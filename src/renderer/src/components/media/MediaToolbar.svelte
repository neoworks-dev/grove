<script lang="ts">
  // The strip under a media viewer: what the file is on the left (size,
  // zoom, page), the viewer's own controls on the right.
  import type { Snippet } from 'svelte'

  let { info, actions }: { info?: Snippet; actions?: Snippet } = $props()
</script>

<div class="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-surface px-2 text-xs text-dim">
  <div class="min-w-0 flex-1 truncate tabular-nums">
    {#if info}{@render info()}{/if}
  </div>
  <div class="flex items-center gap-0.5">
    {#if actions}{@render actions()}{/if}
  </div>
</div>
