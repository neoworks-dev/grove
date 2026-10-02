<script lang="ts">
  // A single xterm view bound to one shell in the terminal daemon. Owned by
  // TerminalPane, which mounts one per open terminal and keeps inactive ones
  // hidden (so their pty keeps streaming and scrollback survives tab switches).
  import { onDestroy } from 'svelte'
  import type { IMarker, Terminal } from '@xterm/xterm'
  import { keymap } from '../lib/keymap.svelte'
  import { createTerminalEscapeHandler } from '../lib/terminalKeys'
  import XtermSurface from './XtermSurface.svelte'
  import {
    commandFromMarker,
    commandOutput,
    typedCommand,
    type FailedCommand
  } from '../lib/terminalCommands'

  let {
    leafId,
    worktreeId,
    attachId,
    active,
    onSession,
    onExit,
    onTitle,
    onStatus,
    onCommandFailed
  }: {
    leafId: string
    worktreeId: string
    /** A shell that is already running; the view takes it over instead of spawning one. */
    attachId?: string
    active: boolean
    /** The daemon's id for this view's shell, once it is known. */
    onSession?: (ptyId: string) => void
    onExit: () => void
    onTitle: (title: string) => void
    onStatus?: (status: { running: boolean; exitCode?: number }) => void
    /** A command exited non-zero; carries what it was and what it printed. */
    onCommandFailed?: (failure: FailedCommand) => void
  } = $props()

  // What a shell reports for a command stopped by SIGINT: 128 + 2.
  const INTERRUPTED_EXIT_CODE = 130

  let surface = $state<XtermSurface>()
  let term = $state.raw<Terminal | null>(null)
  let ptyId: string | null = null
  let stopData: (() => void) | null = null
  let stopExit: (() => void) | null = null
  let stopTitle: (() => void) | null = null
  // Where the shell's prompt ended (OSC 133 B), which is where the typed command
  // starts, and the command running since its C marker. Markers move with the
  // scrollback, so they still point at the right lines when the command ends.
  let promptEnd: { marker: IMarker; column: number } | null = null
  let runningCommand: { command: string; outputStart: IMarker } | null = null

  // Called by the parent when this terminal becomes the active tab.
  export function focus(): void {
    keymap.setPaneMode(leafId, 'terminal')
    term?.focus()
  }

  // Vim-style mode escape: ctrl+\ ctrl+n leaves 'terminal' for 'normal' so
  // global chords (ctrl+hjkl, leader) work again; the parent's 'i' binding
  // re-enters.
  function enterNormalMode(): void {
    keymap.setPaneMode(leafId, 'normal')
    keymap.focusPane(leafId)
  }

  /** Wires the shell's keys and markers into the terminal, then starts the pty once it has a size. */
  function onReady(terminal: Terminal): void {
    term = terminal
    terminal.attachCustomKeyEventHandler(createTerminalEscapeHandler(enterNormalMode))
    // Semantic-prompt markers (OSC 133, emitted by fish and configured shells):
    // "C" fires when a command starts executing, "D;<status>" when it finishes.
    // They drive the tab status dot; unhandled (return false) so other
    // consumers still see them.
    terminal.parser.registerOscHandler(133, (data) => {
      onSemanticPrompt(data)
      return false
    })
    // Clicking back into the terminal resumes terminal mode.
    terminal.textarea?.addEventListener('focus', () => keymap.setPaneMode(leafId, 'terminal'))

    // Start the pty once the view has a size, then wire the streams.
    requestAnimationFrame(() => void start())
  }

  /** One OSC 133 marker: the prompt ending, a command starting, or one finishing. */
  function onSemanticPrompt(data: string): void {
    if (data.startsWith('B')) markPromptEnd()
    if (data.startsWith('C')) {
      markCommandStart(data)
      onStatus?.({ running: true })
    }
    if (data.startsWith('D')) {
      const code = Number.parseInt(data.split(';')[1] ?? '', 10)
      const exitCode = Number.isNaN(code) ? undefined : code
      finishCommand(exitCode)
      onStatus?.({ running: false, exitCode })
    }
  }

  function markPromptEnd(): void {
    if (!term) return
    promptEnd?.marker.dispose()
    const marker = term.registerMarker(0)
    if (!marker) return
    promptEnd = { marker, column: term.buffer.active.cursorX }
  }

  /** Notes the command that starts running and the line its output starts on. */
  function markCommandStart(data: string): void {
    if (!term) return
    runningCommand?.outputStart.dispose()
    runningCommand = null
    const outputStart = term.registerMarker(0)
    if (!outputStart) return
    let command = commandFromMarker(data)
    if (command === null && promptEnd && !promptEnd.marker.isDisposed) {
      command = typedCommand(
        term.buffer.active,
        { line: promptEnd.marker.line, column: promptEnd.column },
        outputStart.line
      )
    }
    runningCommand = { command: command || '', outputStart }
  }

  /** Reports a command that failed, with its output, and forgets it either way. */
  function finishCommand(exitCode: number | undefined): void {
    const finished = runningCommand
    runningCommand = null
    if (!term || !finished) return
    const outputStart = finished.outputStart
    if (isFailure(exitCode) && finished.command && !outputStart.isDisposed) {
      const buffer = term.buffer.active
      const output = commandOutput(buffer, outputStart.line, buffer.baseY + buffer.cursorY)
      onCommandFailed?.({ command: finished.command, exitCode, output })
    }
    outputStart.dispose()
  }

  /** A non-zero exit, other than the 130 of a command the user stopped with Ctrl+C. */
  function isFailure(exitCode: number | undefined): exitCode is number {
    if (exitCode === undefined || exitCode === 0) return false
    return exitCode !== INTERRUPTED_EXIT_CODE
  }

  /**
   * The shell this view talks to: the one it was handed, or a new one.
   *
   * Taking one over replays what it printed while no window was showing it,
   * which is what makes a restored tab read as the terminal it was rather than
   * an empty prompt.
   */
  async function openSession(cols: number, rows: number): Promise<string> {
    if (!attachId) return window.workbench.terminal.create(worktreeId, cols, rows)
    const scrollback = await window.workbench.terminal.attach(attachId, cols, rows)
    if (scrollback) term?.write(scrollback)
    return attachId
  }

  async function start(): Promise<void> {
    if (!term) return
    surface?.fitImmediately()
    ptyId = await openSession(term.cols, term.rows)
    onSession?.(ptyId)

    term.onData((data) => {
      if (ptyId) void window.workbench.terminal.write(ptyId, data)
    })
    term.onResize(({ cols, rows }) => {
      if (ptyId) void window.workbench.terminal.resize(ptyId, cols, rows)
    })
    stopData = window.workbench.on('event:terminal-data', (payload) => {
      const event = payload as { id: string; data: string }
      if (event.id === ptyId) term?.write(event.data)
    })
    stopExit = window.workbench.on('event:terminal-exit', (payload) => {
      const event = payload as { id: string }
      if (event.id !== ptyId) return
      ptyId = null
      term?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
      onExit()
    })
    stopTitle = window.workbench.on('event:terminal-title', (payload) => {
      const event = payload as { id: string; title: string }
      if (event.id === ptyId) onTitle(event.title)
    })
    if (active) term.focus()
  }

  // Becoming the active tab: the host was display:none (zero size), so force a
  // refit against the now-visible box and take focus.
  $effect(() => {
    if (!active || !term) return
    surface?.refit()
    term.focus()
  })

  // Unmounting drops the view, not the shell: the daemon keeps it running so a
  // pane that comes back — or the next launch of grove — can take it over
  // again. Closing the tab is what kills it, and TerminalPane does that.
  onDestroy(() => {
    stopData?.()
    stopExit?.()
    stopTitle?.()
  })
</script>

<XtermSurface bind:this={surface} {leafId} options={{ cursorBlink: true }} {onReady} />
