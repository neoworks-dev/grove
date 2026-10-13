<script lang="ts">
  // The Neoworks landing page scene (sky, sun or moon and stars, five outlined
  // ridges) painted once behind the whole window. The app root is `isolate`, so
  // this sits above its canvas colour and below everything else, and it shows
  // only where nothing opaque covers it: the gaps between panes and empty panes.
  // Drawn when the active theme has a landscape and the mascot setting is on.
  import { store } from '../lib/store.svelte'
  import { settings } from '../lib/settings.svelte'
  import { mountainRidges } from '../lib/mountainRidges'
  import { activeLandscape, starBackground } from '../lib/landscape'

  const scene = $derived(
    activeLandscape(store.activeTheme, settings.get<boolean>('workbench.showMascot'))
  )

  // Back to front, so nearer ridges paint over farther ones.
  const ridges = [
    { path: mountainRidges.far, color: 'var(--scene-ridge-far)' },
    { path: mountainRidges.midFar, color: 'var(--scene-ridge-mid-far)' },
    { path: mountainRidges.mid, color: 'var(--scene-ridge-mid)' },
    { path: mountainRidges.near, color: 'var(--scene-ridge-near)' },
    { path: mountainRidges.front, color: 'var(--scene-ridge-front)' }
  ]

  /** A ridge's top edge only, so the outline does not trace the box it is filled down to. */
  function ridgeLine(path: string): string {
    return path.replace('M0,480 L', 'M').replace(' L1440,480 Z', '')
  }
</script>

{#if scene}
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    style="--scene-sun: {scene.sun}; --scene-ink: {scene.ink}; --scene-ridge-far: {scene.ridgeFar}; --scene-ridge-mid-far: {scene.ridgeMidFar}; --scene-ridge-mid: {scene.ridgeMid}; --scene-ridge-near: {scene.ridgeNear}; --scene-ridge-front: {scene.ridgeFront}"
  >
    <div
      class="absolute inset-0"
      style="background: linear-gradient(to bottom, {scene.sky}, var(--bg))"
    ></div>
    {#if scene.night}
      <div
        class="absolute inset-x-0 top-0 h-2/3"
        style="background-image: {starBackground(scene.star)}"
      ></div>
      <svg viewBox="-4 4 108 98" class="absolute left-[24%] top-[8%] w-[7%] max-w-[110px]">
        <path
          d="M49.5 8 A44 44 0 1 0 88.6 73.1 A38 38 0 0 1 49.5 8 Z"
          fill="#efe6c4"
          stroke="var(--scene-ink)"
          stroke-width="2.5"
          stroke-linejoin="round"
        />
        <circle cx="22" cy="58" r="5" fill="#ddd2ab" />
        <circle cx="34" cy="80" r="3.5" fill="#ddd2ab" />
        <circle cx="28" cy="32" r="3" fill="#ddd2ab" />
      </svg>
    {:else}
      <div
        class="absolute left-[64%] top-[16%] aspect-square w-[10%] max-w-[150px] rounded-full border-[2.5px] bg-[var(--scene-sun)]"
        style="border-color: var(--scene-ink); box-shadow: 0 0 120px 60px var(--scene-sun)"
      ></div>
    {/if}
    {#each ridges as ridge (ridge.path)}
      <svg
        viewBox="0 0 1440 480"
        preserveAspectRatio="xMidYMax slice"
        class="absolute inset-x-0 bottom-0 aspect-[3/1] min-h-[50%] w-full"
      >
        <path d={ridge.path} fill={ridge.color} />
        <path
          d={ridgeLine(ridge.path)}
          fill="none"
          stroke="var(--scene-ink)"
          stroke-width="2.5"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    {/each}
  </div>
{/if}
