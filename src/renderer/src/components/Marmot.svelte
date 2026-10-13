<script lang="ts" module>
  // Every pose is bundled by path, e.g. "sleeping" or "apps/coder". Globbing keeps
  // the asset URLs hashed by Vite while letting callers name a pose by string.
  const poseUrls = import.meta.glob<string>('../assets/marmot/**/*.webp', {
    eager: true,
    query: '?url',
    import: 'default'
  })

  /** Resolves a pose name such as "apps/coder" to its bundled image URL, or null if there is none. */
  function resolvePose(pose: string): string | null {
    const url = poseUrls[`../assets/marmot/${pose}.webp`]
    if (url === undefined) {
      return null
    }
    return url
  }
</script>

<script lang="ts">
  // The Neoworks marmot, decorative only: it sits beside text that already says
  // what is going on, so it carries no alt text.
  let { pose, class: className = '' }: { pose: string; class?: string } = $props()

  const url = $derived(resolvePose(pose))
</script>

{#if url}
  <img src={url} alt="" draggable="false" class="pointer-events-none select-none {className}" />
{/if}
