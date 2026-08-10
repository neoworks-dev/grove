<script lang="ts">
  // Per-provider brand logo for instance tabs / agent rows. Real brand SVGs
  // live in assets/agents; brands without a local asset fall back to a
  // phosphor icon (OpenAI logo, then a generic robot). Inactive instances
  // render desaturated + dimmed.
  import OpenAiLogoIcon from 'phosphor-svelte/lib/OpenAiLogoIcon'
  import RobotIcon from 'phosphor-svelte/lib/RobotIcon'
  import claudeLogo from '../assets/agents/claude.svg'

  let {
    name,
    size = 14,
    active = true
  }: { name: string; size?: number; active?: boolean } = $props()

  function logoFor(provider: string): string {
    if (provider === 'claude' || provider === 'anthropic') return claudeLogo
    return ''
  }

  const src = $derived(logoFor(name))
  const isOpenAi = $derived(name === 'codex' || name === 'openai')
</script>

{#if src}
  <img
    {src}
    alt={name}
    title={name}
    class="shrink-0 object-contain {active ? '' : 'opacity-40 grayscale'}"
    style="width:{size}px;height:{size}px"
  />
{:else if isOpenAi}
  <OpenAiLogoIcon {size} class="shrink-0 {active ? '' : 'opacity-40 grayscale'}" />
{:else}
  <RobotIcon {size} class="shrink-0 {active ? '' : 'opacity-40 grayscale'}" />
{/if}
