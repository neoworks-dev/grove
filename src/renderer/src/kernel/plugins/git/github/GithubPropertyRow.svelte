<script lang="ts">
  // One line of the thread's sidebar: the property's name on the left, its
  // value on the right. A value that can be changed is its own trigger, so the
  // row needs no separate Edit button.
  import type { Snippet } from 'svelte'

  let { name, children }: { name: string; children: Snippet } = $props()
</script>

<div class="grid min-h-6 grid-cols-[72px_minmax(0,1fr)] items-start gap-x-1.5">
  <span class="truncate py-1 text-dim" title={name}>{name}</span>
  <div class="flex min-h-6 min-w-0 items-center">
    {@render children()}
  </div>
</div>
