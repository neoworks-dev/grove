<script lang="ts">
  // Shared keycap: a single visual for keyboard keys across the app (which-key
  // overlay, composer hints, cheatsheets). Matches the which-key styling.
  import type { Snippet } from 'svelte'

  let { children, class: extra = '' }: { children: Snippet; class?: string } = $props()
</script>

<kbd
  class="min-w-5 rounded border border-line bg-surface px-1.5 py-0.5 text-center font-mono text-2xs text-default {extra}"
  >{@render children()}</kbd
>
