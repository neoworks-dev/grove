<script lang="ts">
  // A small icon button on a section header or a row. It stops the click there,
  // so acting on a row never also selects or expands it. The negative margin
  // keeps it from adding height: rows show it only on hover, and a row that
  // grows under the pointer jumps everything below it.
  import type { Component } from 'svelte'

  let {
    icon,
    title,
    disabled = false,
    onclick
  }: {
    icon: Component<{ size?: number }>
    title: string
    disabled?: boolean
    onclick: () => void
  } = $props()

  const Icon = $derived(icon)

  /** Runs the action without letting the click reach the row underneath. */
  function activate(event: MouseEvent): void {
    event.stopPropagation()
    onclick()
  }
</script>

<button
  class="-my-1 grid size-5 shrink-0 place-items-center rounded text-dim hover:bg-raised hover:text-default disabled:opacity-40"
  {title}
  aria-label={title}
  {disabled}
  onclick={activate}
>
  <Icon size={14} />
</button>
