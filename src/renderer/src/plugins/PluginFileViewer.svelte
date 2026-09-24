<script module lang="ts">
  /** What the plugin host registers alongside each of a plugin's viewers. */
  export interface PluginViewerOptions {
    pluginId: string
    page: string
  }
</script>

<script lang="ts">
  // A sandboxed plugin's file viewer: a page from its bundle in a frame that
  // can run scripts and nothing else — no same-origin access to Grove, and
  // main serves the page under a policy with no network. Grove reads the file
  // through the plugin's own `workspace.read` grant, so a denied grant is a
  // viewer with nothing to show, and hands the bytes over by postMessage.
  import { store } from '../lib/store.svelte'
  import { extensionOf } from '../lib/fileUrl'
  import type { FileViewerProps } from '../lib/fileViewers.svelte'
  import type { FileViewerMessage, FileViewerTheme } from '../../../shared/plugins'

  let { worktreeId, path, src, options }: FileViewerProps = $props()

  const plugin = $derived(options as PluginViewerOptions)
  const pageUrl = $derived(`grove-plugin://${plugin.pluginId}/${plugin.page}`)

  let frameEl = $state<HTMLIFrameElement>()
  // Set once the page has said it is listening; nothing is sent before then.
  let pageReady = $state(false)
  let error = $state<string | null>(null)

  // The page announces itself; only messages from this frame count.
  $effect(() => {
    const listener = (event: MessageEvent): void => {
      if (!frameEl || event.source !== frameEl.contentWindow) return
      const message = event.data as FileViewerMessage
      if (message?.type === 'grove.viewer.ready') pageReady = true
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  })

  // Send the file once the page is ready, and again whenever it changes on
  // disk — `src` is re-issued on every change.
  $effect(() => {
    void src
    if (!pageReady) return
    void sendFile(worktreeId, path)
  })

  // Follow Grove's theme while the page is open.
  $effect(() => {
    void store.activeTheme
    if (!pageReady) return
    post({ type: 'grove.viewer.theme', theme: currentTheme() })
  })

  /** Reads the file as the plugin and transfers its bytes to the page. */
  async function sendFile(fileWorktreeId: string, filePath: string): Promise<void> {
    try {
      const data = await readAsPlugin(fileWorktreeId, filePath)
      // A copy the page can own outright; the IPC result may share its buffer.
      const bytes = data.slice().buffer
      error = null
      const name = filePath.split('/').pop() ?? filePath
      const message: FileViewerMessage = {
        type: 'grove.viewer.file',
        path: filePath,
        name,
        extension: extensionOf(filePath),
        bytes,
        theme: currentTheme()
      }
      frameEl?.contentWindow?.postMessage(message, '*', [bytes])
    } catch (cause) {
      error = (cause as Error).message
      post({ type: 'grove.viewer.error', message: error })
    }
  }

  /** The file's bytes, read with the plugin's permissions rather than Grove's. */
  async function readAsPlugin(fileWorktreeId: string, filePath: string): Promise<Uint8Array> {
    const callId = `${plugin.pluginId}-viewer-${Math.random().toString(36).slice(2)}`
    const data: unknown = await window.workbench.plugins.invoke(
      plugin.pluginId,
      callId,
      'workspace.readBytes',
      { worktreeId: fileWorktreeId, path: filePath }
    )
    if (!(data instanceof Uint8Array)) throw new Error('the file came back in an unexpected form')
    return data
  }

  /** Posts a message to the page. Its origin is opaque, hence '*'. */
  function post(message: FileViewerMessage): void {
    frameEl?.contentWindow?.postMessage(message, '*')
  }

  /** The theme's colours, in the shape a viewer page is promised. */
  function currentTheme(): FileViewerTheme {
    const style = getComputedStyle(document.documentElement)
    const background = cssValue(style, '--bg')
    return {
      dark: isDark(background),
      background,
      surface: cssValue(style, '--surface'),
      text: cssValue(style, '--text'),
      textMuted: cssValue(style, '--text-muted'),
      border: cssValue(style, '--border'),
      accent: cssValue(style, '--primary')
    }
  }

  /** A custom property's value on the document, trimmed. */
  function cssValue(style: CSSStyleDeclaration, name: string): string {
    return style.getPropertyValue(name).trim()
  }

  /** Whether a #rrggbb colour is dark; anything else is taken as dark. */
  function isDark(color: string): boolean {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color)
    if (!match) return true
    const [red, green, blue] = match.slice(1).map((part) => parseInt(part, 16))
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    return luminance < 128
  }
</script>

<div class="relative min-h-0 flex-1">
  <iframe
    bind:this={frameEl}
    src={pageUrl}
    title="{plugin.pluginId} viewer"
    sandbox="allow-scripts"
    class="block h-full w-full border-0 bg-canvas"
  ></iframe>
  {#if error !== null}
    <div
      class="absolute inset-0 flex items-center justify-center bg-surface p-6 text-center text-xs text-dim"
    >
      {plugin.pluginId} could not read this file: {error}
    </div>
  {/if}
</div>
