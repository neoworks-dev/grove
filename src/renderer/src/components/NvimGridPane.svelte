<script lang="ts">
  // Grove-pane projection of a non-primary ext_multigrid window. It deliberately
  // owns no process: the owner NvimPane session supplies redraw state and RPC.
  import { onMount } from 'svelte'
  import NvimGridSurface from './NvimGridSurface.svelte'
  import { encodeKeyEvent } from '../lib/nvim/keys'
  import { sessionByNvimId } from '../lib/nvim/registry'
  import type { NvimCanvasSession } from '../lib/nvim/session'

  // Renamed off `state`: a variable of that name in scope makes the compiler
  // read `$state` as a store subscription, and the pane dies on mount with
  // `store_invalid_shape` — which stops the whole tree rendering, not just this
  // pane.
  let { state: paneState }: { state: Record<string, unknown> } = $props()
  const nvimId = String(paneState.nvimId ?? '')
  const grid = Number(paneState.grid)
  const win = Number(paneState.win)
  let session = $state<NvimCanvasSession | null>(null)
  let input = $state<HTMLDivElement>()

  function focus(): void {
    session?.focusWindow(win, false)
    input?.focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!session?.id) return
    const keys = encodeKeyEvent(event)
    if (!keys) return
    event.preventDefault()
    event.stopPropagation()
    void window.workbench.nvim.input(session.id, keys)
  }

  onMount(() => {
    let frame = 0
    const resolve = (): void => {
      session = sessionByNvimId(nvimId) ?? null
      if (!session) frame = requestAnimationFrame(resolve)
    }
    resolve()
    return () => cancelAnimationFrame(frame)
  })
</script>

<div
  data-nvim-ui={nvimId}
  class="relative h-full min-h-0 w-full bg-surface"
  onfocusin={focus}
  onmousedown={focus}
>
  {#if session}
    <NvimGridSurface {session} {grid} {win} focusOwner={false} resizeWindow onFocus={focus} />
  {/if}
  <div
    bind:this={input}
    contenteditable="true"
    class="absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0 outline-none"
    role="textbox"
    tabindex="0"
    aria-label="Neovim split input"
    onkeydown={onKeydown}
  ></div>
</div>
