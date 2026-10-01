<script lang="ts">
  // Marking up an attached image before it is sent: arrows, boxes, freehand,
  // labels, and a blur over anything private. Opened from the composer's
  // attachment; Done hands back the marks and the picture they make, Cancel
  // leaves the attachment as it was.
  //
  // The canvas is the image's own size, scaled down to fit, so marks are kept
  // and drawn in image pixels and the picture sent is at full resolution.
  import { portal } from '@neoworks-dev/ui'
  import Button from '@neoworks-dev/ui/Button'
  import ArrowUpRight from 'phosphor-svelte/lib/ArrowUpRight'
  import Square from 'phosphor-svelte/lib/Square'
  import Scribble from 'phosphor-svelte/lib/Scribble'
  import TextT from 'phosphor-svelte/lib/TextT'
  import DropHalf from 'phosphor-svelte/lib/DropHalf'
  import ArrowUUpLeft from 'phosphor-svelte/lib/ArrowUUpLeft'
  import ArrowUUpRight from 'phosphor-svelte/lib/ArrowUUpRight'
  import ImageSquare from 'phosphor-svelte/lib/ImageSquare'
  import type { Component } from 'svelte'
  import { onDestroy, onMount } from 'svelte'
  import {
    MARK_COLORS,
    addMark,
    commit,
    drawMarkup,
    isMeaningful,
    rectBetween,
    redo,
    startHistory,
    strokeWidthFor,
    textSizeFor,
    undo,
    type Mark,
    type MarkHistory,
    type MarkTool,
    type Point
  } from '../../../../lib/agents/imageMarkup'

  let {
    source,
    marks,
    onDone,
    onCancel
  }: {
    /** The image as it was attached. */
    source: Blob
    /** Marks made the last time it was opened, to carry on from. */
    marks: Mark[]
    /** The marks now on it, and the picture they make — null when there are none. */
    onDone: (marks: Mark[], picture: Blob | null) => void
    onCancel: () => void
  } = $props()

  interface ToolEntry {
    tool: MarkTool
    label: string
    key: string
    icon: Component
  }

  const TOOLS: ToolEntry[] = [
    { tool: 'arrow', label: 'Arrow', key: 'a', icon: ArrowUpRight },
    { tool: 'box', label: 'Box', key: 'r', icon: Square },
    { tool: 'pen', label: 'Freehand', key: 'p', icon: Scribble },
    { tool: 'text', label: 'Text', key: 't', icon: TextT },
    { tool: 'blur', label: 'Blur', key: 'b', icon: DropHalf }
  ]

  let tool = $state<MarkTool>('arrow')
  let color = $state<string>(MARK_COLORS[0])
  // svelte-ignore state_referenced_locally
  let history = $state<MarkHistory>(startHistory(marks))
  // The mark being dragged out, drawn but not yet in the history.
  let draft = $state<Mark | null>(null)
  // A label being typed: where it goes in the image, and where that is on screen.
  let label = $state<{ at: Point; left: number; top: number; text: string } | null>(null)
  let saving = $state(false)
  let failure = $state('')

  let canvas = $state<HTMLCanvasElement>()
  let labelInput = $state<HTMLInputElement>()
  let image = $state<ImageBitmap | null>(null)
  let blurred: HTMLCanvasElement | null = null
  let dragStart: Point | null = null

  onMount(() => {
    void load()
  })

  onDestroy(() => {
    if (image) image.close()
  })

  /** Decodes the image, sizes the canvas to it, and prepares its blurred copy. */
  async function load(): Promise<void> {
    try {
      const bitmap = await createImageBitmap(source)
      blurred = blurredCopy(bitmap)
      image = bitmap
    } catch (error) {
      failure = `The image could not be read: ${(error as Error).message}`
    }
  }

  /** The whole image, blurred hard enough that nothing under a blur mark can be read. */
  function blurredCopy(bitmap: ImageBitmap): HTMLCanvasElement {
    const copy = document.createElement('canvas')
    copy.width = bitmap.width
    copy.height = bitmap.height
    const context = copy.getContext('2d')
    if (!context) return copy
    const radius = Math.max(8, Math.round(Math.max(bitmap.width, bitmap.height) / 80))
    context.filter = `blur(${radius}px)`
    context.drawImage(bitmap, 0, 0)
    return copy
  }

  $effect(() => {
    const shown = [...history.present]
    if (draft) shown.push(draft)
    redraw(shown)
  })

  /** Paints the image and the given marks onto the visible canvas. */
  function redraw(shown: Mark[]): void {
    if (!canvas || !image || !blurred) return
    if (canvas.width !== image.width) canvas.width = image.width
    if (canvas.height !== image.height) canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) return
    drawMarkup(context, image, blurred, shown)
  }

  // ── Pointer ─────────────────────────────────────────────────────

  /** Where a pointer event falls in the image's own pixels. */
  function imagePoint(event: PointerEvent): Point {
    if (!canvas) return { x: 0, y: 0 }
    const bounds = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height
    }
  }

  /** How thick a line is on this image. */
  function strokeWidth(): number {
    if (!image) return 2
    return strokeWidthFor(image.width, image.height)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !canvas) return
    event.preventDefault()
    commitLabel()
    const point = imagePoint(event)
    if (tool === 'text') {
      startLabel(point, event)
      return
    }
    canvas.setPointerCapture(event.pointerId)
    dragStart = point
    draft = markFrom(point, point)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragStart || !draft) return
    const point = imagePoint(event)
    if (draft.kind === 'pen') {
      draft = { ...draft, points: [...draft.points, point] }
      return
    }
    draft = markFrom(dragStart, point)
  }

  function onPointerUp(): void {
    if (!draft) return
    if (isMeaningful(draft)) history = addMark(history, draft)
    draft = null
    dragStart = null
  }

  /** The mark the current tool makes for a drag from `start` to `end`. */
  function markFrom(start: Point, end: Point): Mark {
    const width = strokeWidth()
    if (tool === 'box') return { kind: 'box', rect: rectBetween(start, end), color, width }
    if (tool === 'blur') return { kind: 'blur', rect: rectBetween(start, end) }
    if (tool === 'pen') return { kind: 'pen', points: [start], color, width }
    return { kind: 'arrow', from: start, to: end, color, width }
  }

  // ── Labels ──────────────────────────────────────────────────────

  /** Opens a text field where the label will be, to type it in place. */
  function startLabel(at: Point, event: PointerEvent): void {
    const frame = canvas?.parentElement?.getBoundingClientRect()
    if (!frame) return
    label = { at, left: event.clientX - frame.left, top: event.clientY - frame.top, text: '' }
    queueMicrotask(() => labelInput?.focus())
  }

  /** Keeps the label being typed, when it has any text. */
  function commitLabel(): void {
    if (!label || !image) return
    const mark: Mark = {
      kind: 'text',
      at: label.at,
      text: label.text,
      color,
      size: textSizeFor(image.width, image.height)
    }
    label = null
    if (isMeaningful(mark)) history = addMark(history, mark)
  }

  function onLabelKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      commitLabel()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      label = null
    }
  }

  // ── Actions ─────────────────────────────────────────────────────

  function undoMark(): void {
    commitLabel()
    history = undo(history)
  }

  function redoMark(): void {
    history = redo(history)
  }

  /** Takes every mark off; undo puts them back. */
  function revertToOriginal(): void {
    label = null
    if (history.present.length === 0) return
    history = commit(history, [])
  }

  /** Hands back the marks, and the picture flattened at the image's full size. */
  async function done(): Promise<void> {
    commitLabel()
    const finalMarks = history.present
    if (finalMarks.length === 0) {
      onDone([], null)
      return
    }
    saving = true
    redraw(finalMarks)
    const picture = await new Promise<Blob | null>((resolve) => {
      if (!canvas) {
        resolve(null)
        return
      }
      canvas.toBlob(resolve, 'image/png')
    })
    saving = false
    if (!picture) {
      failure = 'The marked-up image could not be saved.'
      return
    }
    onDone(finalMarks, picture)
  }

  /**
   * The editor's keys, taken before the app's own bindings see them: it is
   * modal, and a letter meant as a tool must not reach the editor behind it.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (label) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (handleShortcut(event)) event.preventDefault()
  }

  /** Runs the shortcut a key press means; says whether it meant one. */
  function handleShortcut(event: KeyboardEvent): boolean {
    const modifier = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (modifier && key === 'z' && event.shiftKey) {
      redoMark()
      return true
    }
    if (modifier && key === 'z') {
      undoMark()
      return true
    }
    if (modifier && key === 'y') {
      redoMark()
      return true
    }
    if (modifier && key === 'enter') {
      void done()
      return true
    }
    if (modifier || event.altKey) return false
    const entry = TOOLS.find((candidate) => candidate.key === key)
    if (!entry) return false
    tool = entry.tool
    return true
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<div
  use:portal
  class="fixed inset-0 z-modal flex flex-col bg-black/80"
  role="dialog"
  aria-modal="true"
  aria-label="Mark up image"
  data-testid="image-markup"
>
  <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-elevated px-3 py-1.5">
    {#each TOOLS as entry (entry.tool)}
      <button
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-2xs"
        class:bg-hover={tool === entry.tool}
        class:text-default={tool === entry.tool}
        class:text-dim={tool !== entry.tool}
        class:hover:text-default={tool !== entry.tool}
        title="{entry.label} ({entry.key})"
        aria-pressed={tool === entry.tool}
        onclick={() => (tool = entry.tool)}
      >
        <entry.icon size={14} />
        {entry.label}
      </button>
    {/each}

    <span class="mx-1.5 h-4 w-px bg-line"></span>

    {#each MARK_COLORS as swatch (swatch)}
      <button
        class="size-5 rounded-full border-2"
        class:border-default={color === swatch}
        class:border-transparent={color !== swatch}
        style:background-color={swatch}
        title="Colour"
        aria-label="Colour {swatch}"
        aria-pressed={color === swatch}
        onclick={() => (color = swatch)}
      ></button>
    {/each}

    <span class="mx-1.5 h-4 w-px bg-line"></span>

    <button
      class="flex size-7 items-center justify-center rounded-md text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Undo (Ctrl+Z)"
      aria-label="Undo"
      disabled={history.past.length === 0}
      onclick={undoMark}
    >
      <ArrowUUpLeft size={14} />
    </button>
    <button
      class="flex size-7 items-center justify-center rounded-md text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Redo (Ctrl+Shift+Z)"
      aria-label="Redo"
      disabled={history.future.length === 0}
      onclick={redoMark}
    >
      <ArrowUUpRight size={14} />
    </button>
    <button
      class="flex h-7 items-center gap-1.5 rounded-md px-2 text-2xs text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Take every mark off; undo puts them back"
      disabled={history.present.length === 0}
      onclick={revertToOriginal}
    >
      <ImageSquare size={14} />
      Original
    </button>

    <div class="ml-auto flex items-center gap-2">
      {#if failure}
        <span class="text-2xs text-red">{failure}</span>
      {/if}
      <Button size="sm" variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={saving || !image} onclick={() => void done()}>
        {saving ? 'Saving…' : 'Done'}
      </Button>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 items-center justify-center p-6">
    <div class="relative max-h-full max-w-full">
      <canvas
        bind:this={canvas}
        class="block max-h-[calc(100vh-6rem)] max-w-full touch-none rounded shadow-overlay"
        class:cursor-crosshair={tool !== 'text'}
        class:cursor-text={tool === 'text'}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      ></canvas>
      {#if label}
        <input
          bind:this={labelInput}
          bind:value={label.text}
          class="absolute min-w-32 rounded border border-line bg-black/60 px-1 py-0.5 text-sm font-semibold outline-none"
          style:left="{label.left}px"
          style:top="{label.top}px"
          style:color
          placeholder="Label, then Enter"
          onkeydown={onLabelKeyDown}
          onblur={commitLabel}
        />
      {/if}
    </div>
  </div>
</div>
