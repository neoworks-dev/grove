<script lang="ts">
  // The "an agent is working" mark: a four-point spark that turns slowly and
  // breathes, rather than a row of bouncing dots. Two nested elements because
  // the turn and the breath run at different speeds — one transform cannot hold
  // both. Colour is inherited via currentColor.
  let { size = 12 }: { size?: number } = $props()
</script>

<span class="spark-turn inline-flex align-middle" aria-hidden="true">
  <svg class="spark-breathe" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path
      d="M12 1c.7 5.6 4.4 9.3 10 10-5.6.7-9.3 4.4-10 10-.7-5.6-4.4-9.3-10-10 5.6-.7 9.3-4.4 10-10Z"
    />
  </svg>
</span>

<style>
  .spark-turn {
    animation: spark-turn 5s linear infinite;
  }

  .spark-breathe {
    animation: spark-breathe 1.8s ease-in-out infinite;
    filter: drop-shadow(0 0 3px currentColor);
  }

  @keyframes spark-turn {
    to {
      transform: rotate(360deg);
    }
  }

  /* The crest is a touch bigger and fully lit; the trough never goes dark, so
     the mark stays readable between beats. */
  @keyframes spark-breathe {
    0%,
    100% {
      transform: scale(0.82);
      opacity: 0.55;
    }
    50% {
      transform: scale(1);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spark-turn,
    .spark-breathe {
      animation: none;
    }
    .spark-breathe {
      opacity: 0.8;
    }
  }
</style>
