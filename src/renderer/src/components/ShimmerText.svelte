<script lang="ts">
  // Text with a highlight sweeping across it, left to right — the "something is
  // happening, nothing to read yet" indicator. The colour comes from the theme
  // (dim base, foreground crest), so the sweep reads as a white glow on a dark
  // theme without being invisible on a light one.

  let { text, class: className = '' }: { text: string; class?: string } = $props()
</script>

<span class="shimmer-text {className}">{text}</span>

<style>
  .shimmer-text {
    background: linear-gradient(100deg, var(--text-dim) 40%, var(--text) 50%, var(--text-dim) 60%);
    background-size: 250% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    animation: shimmer-sweep 1.6s linear infinite;
  }

  /* Decreasing the offset walks the gradient rightwards across the text. */
  @keyframes shimmer-sweep {
    from {
      background-position: 150% 0;
    }
    to {
      background-position: -50% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .shimmer-text {
      animation: none;
      color: var(--text-muted);
      background: none;
    }
  }
</style>
