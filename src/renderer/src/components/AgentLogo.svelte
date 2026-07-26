<script lang="ts">
  // Per-adapter brand logo for instance tabs / agent rows. Real brand SVGs live
  // in assets/agents; add a new adapter by dropping its file and extending the
  // map. Inactive instances render desaturated + dimmed.
  import claudeLogo from '../assets/agents/claude.svg'

  let {
    name,
    size = 14,
    active = true
  }: { name: string; size?: number; active?: boolean } = $props()

  function logoFor(adapter: string): string {
    if (adapter === 'claude') return claudeLogo
    return ''
  }

  const src = $derived(logoFor(name))
</script>

{#if src}
  <img
    {src}
    alt={name}
    title={name}
    class="shrink-0 object-contain {active ? '' : 'opacity-40 grayscale'}"
    style="width:{size}px;height:{size}px"
  />
{:else}
  <span
    class="inline-block shrink-0 rounded-full bg-neutral-600 {active ? '' : 'opacity-40'}"
    style="width:{size}px;height:{size}px"
    title={name}
  ></span>
{/if}
