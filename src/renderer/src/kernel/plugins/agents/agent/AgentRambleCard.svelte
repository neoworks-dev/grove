<script lang="ts">
  // A ramble from the desktop overlay, as a card: what the user said, with
  // what they did (clicked, circled, selected, switched to) as chips where it
  // happened, and the screenshots below. A chip's tooltip is the bracket the
  // model read for it.

  import type { Component } from 'svelte'
  import AppWindow from 'phosphor-svelte/lib/AppWindow'
  import Camera from 'phosphor-svelte/lib/Camera'
  import Circle from 'phosphor-svelte/lib/Circle'
  import Cursor from 'phosphor-svelte/lib/Cursor'
  import CursorClick from 'phosphor-svelte/lib/CursorClick'
  import HandGrabbing from 'phosphor-svelte/lib/HandGrabbing'
  import LineSegment from 'phosphor-svelte/lib/LineSegment'
  import Microphone from 'phosphor-svelte/lib/Microphone'
  import Scribble from 'phosphor-svelte/lib/Scribble'
  import Selection from 'phosphor-svelte/lib/Selection'
  import SquaresFour from 'phosphor-svelte/lib/SquaresFour'
  import { blobUrl } from '../../../../lib/agents/api'
  import { rambleDuration, rambleSegments } from '../../../../lib/agents/rambleCard'
  import type { RambleBlock } from '../../../../lib/agents/types'
  import AgentImage from './AgentImage.svelte'

  let {
    ramble,
    sessionId
  }: {
    ramble: RambleBlock
    sessionId: string
  } = $props()

  const ICONS: Record<string, Component<{ width?: string; height?: string; class?: string }>> = {
    cursor: Cursor,
    click: CursorClick,
    circle: Circle,
    line: LineSegment,
    scribble: Scribble,
    selection: Selection,
    workspace: SquaresFour,
    focus: AppWindow,
    drag: HandGrabbing,
    screenshot: Camera
  }

  let segments = $derived(rambleSegments(ramble.capture))
  let shotCount = $derived(ramble.screenshots.length)

  function iconOf(kind: string): Component<{ width?: string; height?: string; class?: string }> {
    const icon = ICONS[kind]
    if (icon === undefined) return Cursor
    return icon
  }

  /** The cursor resting is a hint, not something the user did on purpose; it sits back. */
  function chipClass(kind: string): string {
    if (kind === 'cursor') return 'border-dashed text-dim'
    return 'text-muted'
  }

  /** `23s · 2 screenshots`. */
  function summary(): string {
    const duration = rambleDuration(ramble.capture)
    if (shotCount === 0) return duration
    if (shotCount === 1) return `${duration} · 1 screenshot`
    return `${duration} · ${shotCount} screenshots`
  }

  function shotLabel(index: number): string {
    const shot = ramble.capture.screenshots[index]
    if (shot === undefined) return `Screenshot ${index + 1}`
    return `Screenshot ${index + 1} · ${shot.monitor}`
  }
</script>

<div class="overflow-hidden rounded-md border border-line-strong bg-surface whitespace-normal">
  <div
    class="flex items-center gap-2 border-b border-line-strong bg-elevated px-3 py-1.5 text-2xs text-muted"
  >
    <Microphone width="12" height="12" class="shrink-0" />
    <span class="font-medium text-default">Ramble</span>
    <span class="text-dim">from the desktop</span>
    <span class="ml-auto font-mono text-dim">{summary()}</span>
  </div>
  <div class="px-3 py-2 text-base leading-relaxed text-default">
    {#each segments as segment, index (index)}
      <!-- Block bodies drop surrounding whitespace, so the chips' margins space them from the words. -->
      {#if segment.kind === 'words'}
        <span>{segment.text}</span>
      {:else}
        {@const Icon = iconOf(segment.event.kind)}
        <span
          class="mx-1 inline-flex max-w-full items-center gap-1 rounded border border-line bg-canvas px-1.5 align-[1px] font-mono text-2xs leading-5 {chipClass(
            segment.event.kind
          )}"
          title={segment.detail}
        >
          <Icon width="11" height="11" class="shrink-0" />
          <span class="truncate">{segment.label}</span>
        </span>
      {/if}
    {/each}
  </div>
  {#if ramble.capture.speechErrors.length > 0}
    <div class="px-3 pb-2 text-2xs text-dim">
      Part of the speech was not transcribed: {ramble.capture.speechErrors.join('; ')}
    </div>
  {/if}
  {#if shotCount > 0}
    <div class="flex flex-wrap gap-2 border-t border-line px-3 py-2">
      {#each ramble.screenshots as ref, index (ref)}
        <figure class="flex flex-col gap-1">
          <AgentImage src={blobUrl(sessionId, ref)} alt={shotLabel(index)} />
          <figcaption class="font-mono text-2xs text-dim">{shotLabel(index)}</figcaption>
        </figure>
      {/each}
    </div>
  {/if}
</div>
