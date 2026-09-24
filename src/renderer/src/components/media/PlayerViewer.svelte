<script lang="ts">
  // Video and audio through Chromium's own player. Video is contained in the
  // pane; audio gets the file's name above its controls, since it has no
  // picture of its own. Seeking works because main answers Range requests.
  import WaveformIcon from 'phosphor-svelte/lib/WaveformIcon'
  import MediaToolbar from './MediaToolbar.svelte'

  let { src, kind, name }: { src: string; kind: 'video' | 'audio'; name: string } = $props()

  let videoWidth = $state(0)
  let videoHeight = $state(0)
  let duration = $state(0)
  let failed = $state(false)

  $effect(() => {
    void src
    failed = false
  })

  /** Takes the size and length of the loaded media for the toolbar. */
  function handleMetadata(event: Event): void {
    const element = event.currentTarget as HTMLMediaElement
    duration = element.duration
    if (element instanceof HTMLVideoElement) {
      videoWidth = element.videoWidth
      videoHeight = element.videoHeight
    }
  }

  function handleError(): void {
    failed = true
  }

  /** The toolbar's summary: the picture's size for a video, then the length. */
  function summary(): string {
    const length = formatDuration(duration)
    if (videoWidth === 0) return length
    return `${videoWidth} × ${videoHeight} · ${length}`
  }

  /** A duration in seconds as m:ss, or h:mm:ss past the hour. */
  function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return ''
    const whole = Math.round(seconds)
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const secondsPart = String(whole % 60).padStart(2, '0')
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secondsPart}`
    return `${minutes}:${secondsPart}`
  }
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas p-6">
  {#if failed}
    <div class="text-xs text-dim">This file can't be played.</div>
  {:else if kind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      {src}
      controls
      preload="metadata"
      class="max-h-full max-w-full rounded-md"
      onloadedmetadata={handleMetadata}
      onerror={handleError}
    ></video>
  {:else}
    <div class="flex w-full max-w-lg flex-col items-center gap-4">
      <WaveformIcon size={48} class="text-dim" />
      <div class="max-w-full truncate text-sm text-default">{name}</div>
      <audio
        {src}
        controls
        preload="metadata"
        class="w-full"
        onloadedmetadata={handleMetadata}
        onerror={handleError}
      ></audio>
    </div>
  {/if}
</div>
<MediaToolbar>
  {#snippet info()}
    {summary()}
  {/snippet}
</MediaToolbar>
