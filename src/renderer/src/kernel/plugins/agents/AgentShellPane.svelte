<script lang="ts">
  // The agent's terminal: every command the session on screen ran, each under
  // its command line, with what it printed streaming in as it runs. Read-only —
  // the one key it takes is Ctrl+C, which stops the running command (or copies
  // the selection, when there is one).
  import { onDestroy, onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import { agentSessions } from '../../../lib/agents/sessions.svelte'
  import { catalog } from '../../../lib/agents/catalog.svelte'
  import { shellOutputs } from '../../../lib/agents/shellOutput.svelte'
  import {
    planTerminalWrite,
    shellCommandsOf,
    type WrittenCommand
  } from '../../../lib/agents/shellTranscript'
  import { inputViewOf } from '../../../lib/agents/tools'
  import { visibleItems, type ToolItem } from '../../../lib/agents/transcript'
  import { layout } from '../../../lib/layout.svelte'
  import { store } from '../../../lib/store.svelte'
  import { cssVar, terminalTheme } from '../../../lib/terminalTheme'

  let { leafId }: { leafId: string } = $props()

  // As the shell terminal's, so the two read alike side by side.
  const BASE_FONT_SIZE = 13

  const worktreePath = $derived(store.selectedWorktree?.path ?? '')
  const sessionId = $derived(worktreePath ? agentSessions.resolveActive(worktreePath) : null)
  const meta = $derived(agentSessions.list.find((session) => session.id === sessionId))
  const live = $derived(sessionId ? agentSessions.live[sessionId] : undefined)

  // Which calls are commands is the harness's to say: its tools declare the
  // ones whose input is a command line. The Agent pane showing the session has
  // loaded them; until it has, a call with a command line counts.
  const shellToolNames = $derived.by(() => {
    const harness = meta?.harness
    if (!harness) return null
    const tools = catalog.byHarness[harness]?.tools
    if (!tools) return null
    return new Set(
      tools.filter((tool) => inputViewOf(tool.display) === 'command').map((tool) => tool.name)
    )
  })

  /** Whether a call ran a command line. */
  function isShellCall(item: ToolItem): boolean {
    if (shellToolNames) return shellToolNames.has(item.name)
    const input = item.input as { command?: unknown } | null
    return typeof input?.command === 'string'
  }

  const commands = $derived.by(() => {
    if (!live || !sessionId) return []
    const items = visibleItems(live.transcript)
    return shellCommandsOf(items, isShellCall, shellOutputs.forSession(sessionId))
  })
  const running = $derived(commands.findLast((command) => command.running))

  let hostEl = $state<HTMLDivElement>()
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let observer: ResizeObserver | null = null
  let written: WrittenCommand[] = []
  let writtenSession: string | null = null

  // Fit only when the host's size actually changes, once per frame: fitting on
  // every ResizeObserver tick feeds xterm's relayout back into the observer
  // (see TerminalView).
  let fitScheduled = false
  let lastWidth = 0
  let lastHeight = 0

  function scheduleFit(): void {
    if (fitScheduled) return
    fitScheduled = true
    requestAnimationFrame(() => {
      fitScheduled = false
      if (!hostEl || !fit) return
      const width = hostEl.clientWidth
      const height = hostEl.clientHeight
      if (width < 2 || height < 2) return
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
    })
  }

  /** Ctrl+C copies a selection, else stops the running command; every other key is the app's. */
  function onKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown' || !event.ctrlKey || event.key.toLowerCase() !== 'c') return false
    const selection = term?.getSelection() ?? ''
    if (selection) {
      void navigator.clipboard.writeText(selection)
      term?.clearSelection()
      return false
    }
    if (sessionId && running) shellOutputs.interrupt(sessionId, running.toolUseId)
    return false
  }

  onMount(() => {
    if (!hostEl) return
    term = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: BASE_FONT_SIZE * layout.fontScale(leafId),
      theme: terminalTheme(),
      convertEol: true,
      cursorInactiveStyle: 'none',
      scrollback: 10_000
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostEl)
    term.attachCustomKeyEventHandler(onKey)
    // Nothing is typed here, so there is no cursor to show.
    term.write('\u001b[?25l')
    observer = new ResizeObserver(scheduleFit)
    observer.observe(hostEl)
    scheduleFit()
  })

  onDestroy(() => {
    observer?.disconnect()
    term?.dispose()
    term = null
  })

  // Write what is new; start over for another session or rewritten history.
  $effect(() => {
    const current = commands
    const session = sessionId
    if (!term) return
    if (session !== writtenSession) written = []
    const plan = planTerminalWrite(written, current)
    if (plan.reset || session !== writtenSession) {
      term.reset()
      term.write('\u001b[?25l')
    }
    for (const chunk of plan.chunks) term.write(chunk)
    written = plan.written
    writtenSession = session
  })

  // Per-pane font zoom, as the shell terminal has it.
  $effect(() => {
    const next = BASE_FONT_SIZE * layout.fontScale(leafId)
    if (!term || term.options.fontSize === next) return
    term.options.fontSize = next
    lastWidth = 0
    lastHeight = 0
    scheduleFit()
  })

  // Follow the app's theme.
  $effect(() => {
    void store.activeTheme
    if (term) term.options.theme = terminalTheme()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-2xs text-dim">
    <span class="min-w-0 truncate text-muted">{meta?.title || 'Agent terminal'}</span>
    {#if running}
      <span class="ml-auto shrink-0"
        >Ctrl+C stops <span class="font-mono">{running.command}</span></span
      >
    {/if}
  </div>
  {#if !sessionId}
    <p class="p-3 text-xs text-dim">No agent session in this worktree.</p>
  {:else if commands.length === 0}
    <p class="p-3 text-xs text-dim">
      The commands this session's agent runs show here as they run.
    </p>
  {/if}
  <div
    class="min-h-0 flex-1 px-2 pt-1"
    class:hidden={!sessionId || commands.length === 0}
    bind:this={hostEl}
  ></div>
</div>
