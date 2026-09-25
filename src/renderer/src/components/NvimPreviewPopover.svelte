<script lang="ts">
  // A preview nvim handed to grove (see lib/nvim/previews.ts), drawn at the
  // cursor to look like the float nvim would have opened: the pane's font at
  // its zoom, a cell per line, the float's colours, code in nvim's own
  // highlighting. Docs render their markdown; a line's diagnostics list the
  // servers' quick fixes, clickable. nvim owns when it closes: this asks
  // (onDismiss), applies fixes (onFix), and hands the keyboard back (onRelease).
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon'
  import { keyDispatch, KeyPriority } from '../lib/keyDispatch'
  import { renderMarkdown } from '../lib/markdown'
  import {
    placePopover,
    type NvimPreview,
    type PreviewTheme,
    type StyledRun
  } from '../lib/nvim/previews'

  let {
    preview,
    anchor,
    pane,
    font,
    focusRequest,
    onFix,
    onDismiss,
    onRelease
  }: {
    preview: NvimPreview
    // The cursor cell's top-left and the line height, in pane pixels.
    anchor: { left: number; top: number; lineHeight: number }
    pane: { width: number; height: number }
    // nvim's font in this pane: family, size at the pane's zoom, cell height.
    font: { family: string; sizePx: number; lineHeight: number }
    // Bumped when nvim asks for the keyboard to move in (a second K).
    focusRequest: number
    onFix: (index: number) => void
    onDismiss: () => void
    onRelease: () => void
  } = $props()

  // The frame's padding, as for the nvim floats Grove frames (NvimPane's
  // FLOAT_PADDING): the text starts on the cursor's column, the frame outside it.
  const PADDING = 8

  let root = $state<HTMLDivElement>()
  let viewport = $state<HTMLDivElement>()
  let focused = $state(false)
  let width = $state(0)
  let height = $state(0)
  const placement = $derived(
    placePopover({ ...anchor, left: anchor.left - PADDING }, { width, height }, pane, 0)
  )
  // As tall as the roomier side of the line allows, less a margin; the rest
  // scrolls.
  const maxHeight = $derived(
    Math.max(anchor.top, pane.height - anchor.top - anchor.lineHeight) - PADDING
  )

  /** The root's colours and font, plus the markdown colours as variables. */
  function frameStyle(theme: PreviewTheme): string {
    const declarations = [
      `left:${placement.left}px`,
      `top:${placement.top}px`,
      `padding:${PADDING}px`,
      `font-family:${font.family}`,
      `font-size:${font.sizePx}px`,
      `line-height:${font.lineHeight}px`
    ]
    if (theme.bg) declarations.push(`background:${theme.bg}`)
    if (theme.fg) declarations.push(`color:${theme.fg}`)
    const variables: [string, string | undefined][] = [
      ['--doc-heading', theme.heading],
      ['--doc-strong', theme.strong],
      ['--doc-raw', theme.raw],
      ['--doc-link', theme.link],
      ['--doc-quote', theme.quote],
      ['--doc-dim', theme.dim]
    ]
    for (const [name, value] of variables) {
      if (value) declarations.push(`${name}:${value}`)
    }
    return declarations.join(';')
  }

  /** A code run's inline style: nvim's colour and attributes for its group. */
  function runStyle(run: StyledRun): string {
    const declarations: string[] = []
    if (run.fg) declarations.push(`color:${run.fg}`)
    if (run.bold) declarations.push('font-weight:bold')
    if (run.italic) declarations.push('font-style:italic')
    if (run.underline) declarations.push('text-decoration:underline')
    return declarations.join(';')
  }

  /** The theme's colour for a diagnostic severity, as nvim's Diagnostic* groups. */
  function severityColour(severity: number, theme: PreviewTheme): string {
    let colour = theme.hint
    if (severity === 1) colour = theme.error
    if (severity === 2) colour = theme.warn
    if (severity === 3) colour = theme.info
    if (colour === undefined) return ''
    return `color:${colour}`
  }

  /** Severity label for screen readers and the dot's title. */
  function severityName(severity: number): string {
    if (severity === 1) return 'Error'
    if (severity === 2) return 'Warning'
    if (severity === 3) return 'Info'
    return 'Hint'
  }

  /** Scrolls the content by `lines` lines of the pane's font. */
  function scrollLines(lines: number): void {
    viewport?.scrollBy({ top: lines * font.lineHeight })
  }

  /** Half the visible height, in lines, as <C-d> and <C-u> scroll. */
  function halfPage(): number {
    if (!viewport) return 1
    return Math.max(1, Math.floor(viewport.clientHeight / font.lineHeight / 2))
  }

  /** Scroll keys, as in an nvim float: j/k, <C-d>/<C-u>, g/G and the arrows. */
  function scrollFor(event: KeyboardEvent): (() => void) | null {
    if (event.key === 'j' || event.key === 'ArrowDown') return () => scrollLines(1)
    if (event.key === 'k' || event.key === 'ArrowUp') return () => scrollLines(-1)
    if ((event.ctrlKey && event.key === 'd') || event.key === 'PageDown') {
      return () => scrollLines(halfPage())
    }
    if ((event.ctrlKey && event.key === 'u') || event.key === 'PageUp') {
      return () => scrollLines(-halfPage())
    }
    if (event.key === 'g' || event.key === 'Home') return () => viewport?.scrollTo({ top: 0 })
    if (event.key === 'G' || event.key === 'End') {
      return () => viewport?.scrollTo({ top: viewport.scrollHeight })
    }
    return null
  }

  /**
   * Keys while the popover has the keyboard: Escape and q close it, the scroll
   * keys scroll it, copy copies the selection, and anything else goes back to
   * nvim, where it moves on as if the popover had never been entered.
   */
  function handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape' || event.key === 'q') {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      return true
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'c') return true
    const scroll = scrollFor(event)
    if (scroll !== null) {
      event.preventDefault()
      event.stopPropagation()
      scroll()
      return true
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return true
    focused = false
    onRelease()
    return false
  }

  // Take the keyboard when nvim asks (a second K).
  $effect(() => {
    if (focusRequest === 0) return
    root?.focus()
  })

  // Only while focused does the popover sit in the key chain, above bindings.
  $effect(() => {
    if (!focused) return
    return keyDispatch.subscribe(KeyPriority.overlay, handleKey)
  })
</script>

<!-- The popover swallows its own pointer events so a click to select text or
     press a fix never lands on the canvas underneath and moves nvim's cursor,
     which would close it. -->
<div
  bind:this={root}
  class="nvim-preview absolute z-overlay w-max max-w-[calc(100%-1rem)] rounded-lg border border-line bg-elevated text-default shadow-2xl outline-none"
  class:border-line-strong={focused}
  style={frameStyle(preview.theme)}
  bind:clientWidth={width}
  bind:clientHeight={height}
  role="dialog"
  aria-label="Preview"
  tabindex="-1"
  onfocusin={() => (focused = true)}
  onfocusout={(event) => {
    if (!root?.contains(event.relatedTarget as Node | null)) focused = false
  }}
  onmousedown={(event) => event.stopPropagation()}
  onpointerdown={(event) => event.stopPropagation()}
  onwheel={(event) => event.stopPropagation()}
>
  <FloatingScrollbar bind:viewport style="max-height:{maxHeight}px">
    {#if preview.kind === 'doc'}
      <div class="flex flex-col gap-[1lh]">
        {#each preview.blocks as block, index (index)}
          {#if block.kind === 'code'}
            <div class="whitespace-pre-wrap break-words">
              {#each block.lines as line, lineIndex (lineIndex)}
                <div class="min-h-[1lh]">
                  {#each line as run, runIndex (runIndex)}<span style={runStyle(run)}
                      >{run.text}</span
                    >{/each}
                </div>
              {/each}
            </div>
          {:else if block.kind === 'text'}
            <div class="whitespace-pre-wrap break-words">{block.text}</div>
          {:else}
            <div class="nvim-doc break-words">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(block.text)}
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      {#each preview.diagnostics as diagnostic, index (index)}
        <div class="flex whitespace-pre-wrap" style={severityColour(diagnostic.severity, preview.theme)}>
          <span class="shrink-0" title={severityName(diagnostic.severity)}>●&nbsp;</span>
          <span class="min-w-0">
            {diagnostic.message}{#if diagnostic.source || diagnostic.code}<span class="nvim-dim"
                >{#if diagnostic.source}&nbsp;{diagnostic.source}{/if}{#if diagnostic.code}&nbsp;{diagnostic.code}{/if}</span
              >{/if}
          </span>
        </div>
      {/each}
      {#if preview.fixes === null}
        <div class="nvim-dim">&nbsp;&nbsp;Looking for fixes…</div>
      {:else}
        {#each preview.fixes as fix, index (index)}
          <button
            class="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center rounded px-1 text-left hover:bg-hover"
            onclick={() => onFix(index + 1)}
          >
            <WrenchIcon size={font.sizePx - 2} class="shrink-0 text-accent" />
            <span class="min-w-0 truncate">&nbsp;{fix}</span>
          </button>
        {/each}
      {/if}
    {/if}
  </FloatingScrollbar>
</div>

<style>
  /* Markdown as nvim's float shows it: one font and size throughout, headings
     and emphasis told apart by colour and weight, a blank line between
     paragraphs, inline code in the raw colour with no box around it. */
  .nvim-dim {
    color: var(--doc-dim, var(--color-dim));
  }
  .nvim-doc :global(:where(p, ul, ol, blockquote, pre, table, hr)) {
    margin: 0;
  }
  .nvim-doc :global(:where(p, ul, ol, blockquote, pre, table, h1, h2, h3, h4, h5, h6) + *) {
    margin-top: 1lh;
  }
  .nvim-doc :global(:where(h1, h2, h3, h4, h5, h6)) {
    margin: 0;
    font-size: inherit;
    font-weight: bold;
    color: var(--doc-heading, inherit);
  }
  .nvim-doc :global(strong) {
    color: var(--doc-strong, inherit);
  }
  .nvim-doc :global(code) {
    font-family: inherit;
    font-size: inherit;
    color: var(--doc-raw, inherit);
  }
  .nvim-doc :global(a) {
    color: var(--doc-link, inherit);
    text-decoration: underline;
  }
  .nvim-doc :global(blockquote) {
    color: var(--doc-quote, inherit);
    padding-left: 1ch;
    border-left: 1px solid currentColor;
  }
  .nvim-doc :global(:where(ul, ol)) {
    padding-left: 2ch;
  }
  .nvim-doc :global(ul) {
    list-style: '- ';
  }
  .nvim-doc :global(ol) {
    list-style: decimal;
  }
  .nvim-doc :global(hr) {
    border: 0;
    border-top: 1px solid var(--doc-dim, var(--color-line));
    margin-block: calc(0.5lh);
  }
</style>
