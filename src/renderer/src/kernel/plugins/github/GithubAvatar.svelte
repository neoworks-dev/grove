<script lang="ts">
  // A round avatar, falling back to the initial on a tinted disc. Deleted
  // accounts have no avatar at all, and a request can fail for reasons the pane
  // cannot fix (offline, a private avatar host), so the fallback is not an edge
  // case — it is the normal appearance for anyone GitHub gives us nothing for.
  import type { GithubActor } from '../../../../../shared/types'

  let {
    actor,
    size = 20
  }: {
    actor: GithubActor
    size?: number
  } = $props()

  let failed = $state(false)

  // Reset when the row is reused for someone else.
  $effect(() => {
    void actor.avatarUrl
    failed = false
  })

  const showImage = $derived(actor.avatarUrl !== null && !failed)
  const initial = $derived(
    actor.login
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 1)
      .toUpperCase()
  )

  // GitHub serves whatever size is asked for; asking for double keeps it sharp
  // on a HiDPI display without downloading a full-size portrait.
  const source = $derived.by<string>(() => {
    if (actor.avatarUrl === null) return ''
    const separator = actor.avatarUrl.includes('?') ? '&' : '?'
    return `${actor.avatarUrl}${separator}s=${size * 2}`
  })
</script>

{#if showImage}
  <img
    class="shrink-0 rounded-full bg-raised object-cover"
    style:width="{size}px"
    style:height="{size}px"
    src={source}
    alt=""
    title={actor.login}
    loading="lazy"
    onerror={() => (failed = true)}
  />
{:else}
  <span
    class="flex shrink-0 select-none items-center justify-center rounded-full bg-raised font-mono text-dim"
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.round(size * 0.5)}px"
    title={actor.login}
    aria-hidden="true"
  >
    {initial}
  </span>
{/if}
