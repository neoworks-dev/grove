<script lang="ts">
  // A small icon button on a header or a row, drawn like Grove's own row
  // actions. It stops the click there, so acting on a row never selects it.
  import type { IconComponent } from '@neoworks-dev/ui'

  let {
    icon: Icon,
    title,
    tone = 'default',
    onclick
  }: {
    icon: IconComponent
    title: string
    tone?: 'default' | 'danger'
    onclick: () => void
  } = $props()

  /** Runs the action without letting the click reach the row underneath. */
  function activate(event: MouseEvent): void {
    event.stopPropagation()
    onclick()
  }
</script>

<button
  class="-my-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-dim hover:bg-raised"
  class:hover:text-red={tone === 'danger'}
  class:hover:text-default={tone !== 'danger'}
  {title}
  aria-label={title}
  onclick={activate}
>
  <Icon size={14} />
</button>
