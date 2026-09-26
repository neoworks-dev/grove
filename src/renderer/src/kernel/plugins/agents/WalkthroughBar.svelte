<script lang="ts">
  // The running walkthrough, over the editor it plays in: which step of how
  // many, what it is, and the way to the next one without going back to the
  // conversation. Esc takes the mark off but keeps the place; ✕ ends it.
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import PathIcon from 'phosphor-svelte/lib/PathIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import { walkthrough } from '../../../lib/agents/walkthrough.svelte'
  import type { CodeLocation } from '../../../lib/agents/types'

  // Given to every editor overlay; the bar needs neither.
  let { leafId: _leafId, tick: _tick }: { leafId: string; tick: number } = $props()

  const walk = $derived(walkthrough.current)

  /** What a step is called on the bar: its title, else where it is. */
  function nameOf(step: CodeLocation, root: string): string {
    if (step.title) return step.title
    const prefix = `${root}/`
    let path = step.path
    if (path.startsWith(prefix)) path = path.slice(prefix.length)
    if (step.startLine === undefined) return path
    return `${path}:${step.startLine}`
  }
</script>

{#if walk}
  {@const step = walk.steps[walk.index]}
  <div
    class="absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-88px)] -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-elevated py-1 pl-2 pr-1 text-2xs shadow-lg"
    role="toolbar"
    aria-label="Walkthrough"
    data-testid="walkthrough-bar"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    <span class="shrink-0 text-violet"><PathIcon size={12} /></span>
    <span class="shrink-0 font-mono text-dim">{walk.index + 1} / {walk.steps.length}</span>
    <span class="min-w-0 truncate px-1 text-default" title={step.note ?? ''}>
      {nameOf(step, walk.root)}
    </span>
    <button
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Previous step (Alt+Left)"
      aria-label="Previous step"
      disabled={walk.index === 0}
      onclick={() => walkthrough.previous()}
    >
      <CaretLeftIcon size={12} />
    </button>
    <button
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Next step (Alt+Right)"
      aria-label="Next step"
      disabled={walk.index === walk.steps.length - 1}
      onclick={() => walkthrough.next()}
    >
      <CaretRightIcon size={12} />
    </button>
    <button
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-hover hover:text-default"
      title="End the walkthrough"
      aria-label="End the walkthrough"
      onclick={() => walkthrough.end()}
    >
      <XIcon size={12} />
    </button>
  </div>
{/if}
