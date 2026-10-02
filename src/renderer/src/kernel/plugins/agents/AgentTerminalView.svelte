<script lang="ts">
  // One terminal of the agent terminal pane: the agent's commands written one
  // after another, each under its command line, with what it printed streaming
  // in. While a command runs, the keyboard reaches it: typing goes into its
  // terminal in main, Ctrl+C stops it, and the view's size is its terminal's size.
  import type { Terminal } from '@xterm/xterm'
  import XtermSurface from '../../../components/XtermSurface.svelte'
  import { keymap } from '../../../lib/keymap.svelte'
  import { createTerminalEscapeHandler } from '../../../lib/terminalKeys'
  import { shellOutputs } from '../../../lib/agents/shellOutput.svelte'
  import {
    ansiOfTokens,
    planTerminalWrite,
    type CommandPainter,
    type ShellCommand,
    type WrittenCommand
  } from '../../../lib/agents/shellTranscript'
  import { isTerminalReply } from '../../../lib/agents/terminalReplies'
  import { highlightCodeSync } from '../../../lib/highlight'
  import { store } from '../../../lib/store.svelte'

  let {
    leafId,
    sessionId,
    commands,
    grammarSettled,
    hidden = false
  }: {
    leafId: string
    sessionId: string
    commands: ShellCommand[]
    /** Whether the shell grammar has loaded, so prompts are coloured from the first. */
    grammarSettled: boolean
    hidden?: boolean
  } = $props()

  const COMMAND_LANGUAGE = 'shell'

  let surface = $state<XtermSurface>()
  let term = $state.raw<Terminal | null>(null)
  let written: WrittenCommand[] = []
  let writtenSession: string | null = null
  let writtenScheme: string | null = null

  // The command the keyboard reaches: the last one, while it runs.
  const target = $derived.by(() => {
    const last = commands.at(-1)
    if (!last || !last.running) return null
    return last
  })

  /** Focuses the terminal for typing. */
  export function focus(): void {
    keymap.setPaneMode(leafId, 'terminal')
    term?.focus()
  }

  /** The command in bold, coloured as shell when the grammar has loaded. */
  function paintCommand(command: string, scheme: 'dark' | 'light'): string {
    const lines = highlightCodeSync(command, COMMAND_LANGUAGE, scheme)
    if (!lines) return `\u001b[1m${command}\u001b[0m`
    return `\u001b[1m${ansiOfTokens(lines)}\u001b[0m`
  }

  /** Ctrl+\ Ctrl+N gives the keys back to the app; Ctrl+C with a selection copies it. */
  function wireKeys(terminal: Terminal): void {
    const escape = createTerminalEscapeHandler(() => {
      keymap.setPaneMode(leafId, 'normal')
      keymap.focusPane(leafId)
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (!escape(event)) return false
      if (event.type !== 'keydown' || !event.ctrlKey || event.key.toLowerCase() !== 'c') return true
      const selection = terminal.getSelection()
      if (!selection) return true
      void navigator.clipboard.writeText(selection)
      terminal.clearSelection()
      return false
    })
  }

  /** What the user types goes to the running command, if there is one. */
  function onInput(data: string): void {
    if (!target || isTerminalReply(data)) return
    sendToCommand(target.toolUseId, data)
  }

  /** Typing into the running command; Ctrl+C stops it even where it takes no input. */
  function sendToCommand(id: string, data: string): void {
    if (data === '\u0003') {
      shellOutputs.interrupt(sessionId, id)
      return
    }
    shellOutputs.write(sessionId, id, data)
  }

  function onReady(terminal: Terminal): void {
    wireKeys(terminal)
    terminal.onData(onInput)
    terminal.onResize(({ cols, rows }) => {
      if (target) shellOutputs.resize(sessionId, target.toolUseId, cols, rows)
    })
    terminal.textarea?.addEventListener('focus', () => keymap.setPaneMode(leafId, 'terminal'))
    term = terminal
  }

  // A command that starts running gets the view's size for its terminal.
  $effect(() => {
    const id = target?.toolUseId
    if (!id || !term) return
    shellOutputs.resize(sessionId, id, term.cols, term.rows)
  })

  // Shown again after being hidden, the grid is fitted to the space it now has.
  $effect(() => {
    if (!hidden) surface?.refit()
  })

  // Write what is new; start over for another session, rewritten history, or
  // a scheme change that recolours the command lines.
  $effect(() => {
    const current = commands
    const session = sessionId
    const scheme = store.activeTheme.scheme
    if (!term || !grammarSettled) return
    const startOver = session !== writtenSession || scheme !== writtenScheme
    if (startOver) written = []
    const paint: CommandPainter = (command) => paintCommand(command, scheme)
    const plan = planTerminalWrite(written, current, paint)
    if (plan.reset || startOver) term.reset()
    for (const chunk of plan.chunks) term.write(chunk)
    written = plan.written
    writtenSession = session
    writtenScheme = scheme
  })
</script>

<div class="h-full min-h-0" class:hidden>
  <XtermSurface
    bind:this={surface}
    {leafId}
    options={{
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 10_000
    }}
    {onReady}
  />
</div>
