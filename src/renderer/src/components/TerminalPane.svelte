<script lang="ts">
  // Integrated terminal panel: hosts one or more shells as tabs. Every open
  // terminal stays mounted (inactive ones hidden) so its pty keeps streaming and
  // its scrollback survives switching. A list on the right gives an overview of
  // all launched terminals and lets the user add, select, and close them.
  import { onMount, onDestroy } from 'svelte'
  import TerminalView from './TerminalView.svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'

  let { leafId }: { leafId: string } = $props()

  interface TerminalSession {
    key: string
    title: string
    worktreeId: string
  }

  let sessions = $state<TerminalSession[]>([])
  let activeKey = $state<string | null>(null)
  // Monotonic — closing a terminal never renumbers the survivors.
  let counter = 0

  // Exported focus() of each mounted TerminalView, keyed by session.
  const views: Record<string, { focus: () => void }> = {}

  function focusActive(): void {
    if (activeKey) views[activeKey]?.focus()
  }

  // Called by the bottom panel when the Terminal tab becomes active.
  export function focus(): void {
    focusActive()
  }

  function newTerminal(): void {
    counter += 1
    const session: TerminalSession = {
      key: `term-${counter}`,
      title: `Terminal ${counter}`,
      worktreeId: store.selectedWorktreeId
    }
    sessions = [...sessions, session]
    activeKey = session.key
  }

  // Name each terminal after its running foreground process (falls back to the
  // static "Terminal N" until the first sample arrives).
  function setTitle(key: string, title: string): void {
    sessions = sessions.map((session) =>
      session.key === key ? { ...session, title } : session
    )
  }

  function selectTerminal(key: string): void {
    activeKey = key
    // Defer focus until the newly-shown view has laid out.
    requestAnimationFrame(() => views[key]?.focus())
  }

  // Remove a terminal from the panel. Its TerminalView unmounts and kills the
  // pty. Closing the last one closes the whole pane.
  function closeTerminal(key: string): void {
    const index = sessions.findIndex((session) => session.key === key)
    if (index < 0) return
    delete views[key]
    sessions = sessions.filter((session) => session.key !== key)
    if (sessions.length === 0) {
      layout.closeLeaf(leafId)
      return
    }
    if (activeKey === key) {
      const neighbor = sessions[Math.min(index, sessions.length - 1)]
      selectTerminal(neighbor.key)
    }
  }

  let unregisterBindings: (() => void) | null = null

  onMount(() => {
    newTerminal()
    // Vim-style: in 'normal' the terminal keeps focus for pane nav; 'i' hands
    // the keyboard back to the active shell.
    unregisterBindings = keymap.registerBindings([
      {
        id: `terminal.insert:${leafId}`,
        keys: 'i',
        context: leafId,
        mode: 'normal',
        group: 'Terminal',
        description: 'Enter terminal mode',
        run: () => focusActive()
      }
    ])
  })

  onDestroy(() => unregisterBindings?.())
</script>

<div class="flex h-full w-full bg-canvas">
  <!-- Terminal stack: only the active view is visible; the rest keep running. -->
  <div class="relative min-w-0 flex-1">
    {#each sessions as session (session.key)}
      <div class="absolute inset-0 {session.key === activeKey ? '' : 'hidden'}">
        <TerminalView
          bind:this={views[session.key]}
          {leafId}
          worktreeId={session.worktreeId}
          active={session.key === activeKey}
          onExit={() => closeTerminal(session.key)}
          onTitle={(title) => setTitle(session.key, title)}
        />
      </div>
    {/each}
  </div>

  <!-- Right: overview of all launched terminals. -->
  <div class="flex w-44 shrink-0 flex-col border-l border-line bg-elevated">
    <div class="flex h-7 shrink-0 items-center justify-between border-b border-line px-2">
      <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Terminals</span>
      <button
        class="flex h-5 w-5 items-center justify-center rounded text-dim transition hover:bg-hover hover:text-default"
        title="New terminal"
        onclick={newTerminal}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto py-1">
      {#each sessions as session (session.key)}
        <div
          class="group mx-1 flex items-center gap-2 rounded px-2 py-1 {session.key === activeKey
            ? 'bg-hover text-default'
            : 'text-muted hover:bg-hover/60 hover:text-default'}"
        >
          <button
            class="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
            onclick={() => selectTerminal(session.key)}
          >
            <svg class="shrink-0 opacity-70" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 17l6-6-6-6M12 19h8" />
            </svg>
            <span class="truncate">{session.title}</span>
          </button>
          <button
            class="shrink-0 text-dim opacity-0 transition hover:text-default group-hover:opacity-100"
            title="Close terminal"
            onclick={() => closeTerminal(session.key)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  </div>
</div>
