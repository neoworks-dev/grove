<script lang="ts">
  // One coloured status word. The mapping from a semantic tone to a palette
  // class lives here so the rest of the pane never builds class strings.
  import type { Snippet } from 'svelte'
  import type { Tone } from './filter'

  let {
    tone = 'dim',
    title,
    children
  }: { tone?: Tone; title?: string; children: Snippet } = $props()
</script>

<span
  class="shrink-0 font-mono text-2xs"
  class:text-green={tone === 'green'}
  class:text-red={tone === 'red'}
  class:text-amber={tone === 'amber'}
  class:text-violet={tone === 'violet'}
  class:text-blue={tone === 'blue'}
  class:text-dim={tone === 'dim'}
  {title}
>
  {@render children()}
</span>
