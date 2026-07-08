<script lang="ts">
  // A row of dots that bob up and down out of phase, so a sine crest travels
  // across them — the agent "working" indicator. Color is inherited via
  // currentColor; size stays small for a status bar.
  let { count = 5 }: { count?: number } = $props()

  const dots = $derived(Array.from({ length: count }, (_unused, index) => index))
</script>

<span class="inline-flex items-center gap-[3px] align-middle" aria-hidden="true">
  {#each dots as index (index)}
    <span class="ai-wave-dot" style="animation-delay: {index * 0.12}s"></span>
  {/each}
</span>

<style>
  .ai-wave-dot {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 9999px;
    background: currentColor;
    animation: ai-wave 0.9s ease-in-out infinite;
  }

  @keyframes ai-wave {
    0%,
    100% {
      transform: translateY(3px);
      opacity: 0.45;
    }
    50% {
      transform: translateY(-3px);
      opacity: 1;
    }
  }
</style>
