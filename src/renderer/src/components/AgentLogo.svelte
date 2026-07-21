<script lang="ts">
  // Per-adapter brand logo for instance tabs / agent rows. Real brand SVGs live
  // in assets/agents; add a new adapter by dropping its file and extending the
  // map. Inactive instances render desaturated + dimmed.
  import { store } from '../lib/store.svelte'
  import claudeLogo from '../assets/agents/claude.svg'
  import codexLogo from '../assets/agents/codex.svg'
  import opencodeDark from '../assets/agents/opencode-dark.svg'
  import opencodeLight from '../assets/agents/opencode-light.svg'

  let {
    name,
    size = 14,
    active = true
  }: { name: string; size?: number; active?: boolean } = $props()

  // opencode ships light/dark marks; pick the one that reads on the current UI.
  const opencodeLogo = $derived(store.activeTheme.scheme === 'light' ? opencodeLight : opencodeDark)

  function logoFor(adapter: string): string {
    if (adapter === 'claude') return claudeLogo
    if (adapter === 'codex') return codexLogo
    if (adapter === 'opencode') return opencodeLogo
    return ''
  }

  const src = $derived(logoFor(name))
  // The codex/ChatGPT mark is monochrome black — invert it to white on a dark UI.
  const invert = $derived(name === 'codex' && store.activeTheme.scheme === 'dark')
</script>

{#if src}
  <img
    {src}
    alt={name}
    title={name}
    class="shrink-0 object-contain {invert ? 'invert' : ''} {active ? '' : 'opacity-40 grayscale'}"
    style="width:{size}px;height:{size}px"
  />
{:else}
  <span
    class="inline-block shrink-0 rounded-full bg-neutral-600 {active ? '' : 'opacity-40'}"
    style="width:{size}px;height:{size}px"
    title={name}
  ></span>
{/if}
