<script lang="ts">
  // Integrated terminal panel: hosts one or more shells as tabs. Every open
  // terminal stays mounted (inactive ones hidden) so its pty keeps streaming and
  // its scrollback survives switching. A tab strip along the top — styled like
  // the editor buffer tabs — lists all launched terminals and lets the user
  // add, select, and close them.
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

  let stripEl = $state<HTMLDivElement>()

  function focusActive(): void {
    if (activeKey) views[activeKey]?.focus()
  }

  // Called by the bottom panel when the Terminal tab becomes active.
  export function focus(): void {
    focusActive()
  }

  // Mirrors the editor buffer tab styling: the active tab reads as elevated,
  // inactive tabs stay dim until hovered.
  function tabClass(key: string): string {
    if (key === activeKey) {
      return 'border-x border-line bg-elevated text-default'
    }
    return 'border-y border-line text-dim hover:bg-hover hover:text-default'
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

  // Keep the active tab visible when the strip is scrolled elsewhere.
  $effect(() => {
    const active = activeKey
    if (!stripEl || !active) return
    for (const el of stripEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      if (el.dataset.tab !== active) continue
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      return
    }
  })

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

<div class="flex h-full w-full flex-col bg-elevated">
  <!-- Top: tab strip of all launched terminals, like the editor buffer tabs. -->
  <div class="flex h-7 shrink-0 items-stretch bg-surface">
    <div bind:this={stripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
      <div class="flex h-full w-max items-stretch">
        {#each sessions as session (session.key)}
          <div
            data-tab={session.key}
            class="group/tab flex h-7 shrink-0 cursor-pointer items-center px-3 text-xs {tabClass(
              session.key
            )}"
          >
            <button
              class="flex cursor-pointer items-center gap-1.5"
              onclick={() => selectTerminal(session.key)}
            >
              <svg class="shrink-0 opacity-70" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 17l6-6-6-6M12 19h8" />
              </svg>
              <span class="max-w-40 truncate">{session.title}</span>
            </button>
            <button
              class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
              title="Close terminal"
              onclick={() => closeTerminal(session.key)}>✕</button
            >
          </div>
        {/each}
      </div>
    </div>
    <button
      class="flex w-7 shrink-0 cursor-pointer items-center justify-center border-l border-line text-dim transition hover:bg-hover hover:text-default"
      title="New terminal"
      onclick={newTerminal}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </div>

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
</div>
