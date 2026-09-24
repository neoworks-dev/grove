<script lang="ts">
  // One control in a media viewer's toolbar; `active` marks a mode that is on.
  import type { Snippet } from 'svelte'

  let {
    title,
    active = false,
    disabled = false,
    onclick,
    children
  }: {
    title: string
    active?: boolean
    disabled?: boolean
    onclick: () => void
    children: Snippet
  } = $props()
</script>

<button
  class="flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-1.5 text-xs disabled:cursor-default disabled:opacity-40"
  class:bg-elevated={active}
  class:text-default={active}
  class:hover:bg-hover={!active}
  class:hover:text-default={!active}
  {title}
  aria-label={title}
  aria-pressed={active}
  {disabled}
  {onclick}
>
  {@render children()}
</button>
