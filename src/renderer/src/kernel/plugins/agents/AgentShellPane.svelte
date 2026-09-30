<script lang="ts">
  // The agent's terminal: every command the session on screen ran, each under
  // its command line, with what it printed streaming in as it runs. Read-only —
  // the one key it takes is Ctrl+C, which stops the running command (or copies
  // the selection, when there is one).
  import type { Terminal } from '@xterm/xterm'
  import XtermSurface from '../../../components/XtermSurface.svelte'
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
  import { store } from '../../../lib/store.svelte'

  let { leafId }: { leafId: string } = $props()

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

  let term = $state.raw<Terminal | null>(null)
  let written: WrittenCommand[] = []
  let writtenSession: string | null = null

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

  /** Takes the keys this read-only terminal handles, and hides its cursor. */
  function onReady(terminal: Terminal): void {
    terminal.attachCustomKeyEventHandler(onKey)
    // Nothing is typed here, so there is no cursor to show.
    terminal.write('\u001b[?25l')
    term = terminal
  }

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
  <div class="min-h-0 flex-1" class:hidden={!sessionId || commands.length === 0}>
    <XtermSurface
      {leafId}
      options={{ convertEol: true, cursorInactiveStyle: 'none', scrollback: 10_000 }}
      {onReady}
    />
  </div>
</div>
