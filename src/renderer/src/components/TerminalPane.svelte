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

  // Per-terminal command status from the shell's OSC 133 markers: blue while a
  // command runs, then green/red for the last exit code.
  let statuses = $state<Record<string, { running: boolean; exitCode?: number }>>({})

  function setStatus(key: string, status: { running: boolean; exitCode?: number }): void {
    statuses = { ...statuses, [key]: status }
  }

  // Exported focus() of each mounted TerminalView, keyed by session.
  const views: Record<string, { focus: () => void }> = {}

  let stripEl = $state<HTMLDivElement>()

  // Wide panes park the terminal list as a column on the right; tall panes
  // keep it as a top row.
  let paneWidth = $state(0)
  let paneHeight = $state(0)
  const sideStrip = $derived(paneWidth > paneHeight)

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
    sessions = sessions.map((session) => (session.key === key ? { ...session, title } : session))
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

{#snippet terminalTab(session: TerminalSession)}
  {@const active = session.key === activeKey}
  {@const status = statuses[session.key]}
  <div
    data-tab={session.key}
    class="group/tab flex shrink-0 cursor-pointer items-center rounded-md px-2 py-1.5 text-xs"
    class:w-full={sideStrip}
    class:bg-elevated={active}
    class:text-default={active}
    class:text-dim={!active}
    class:hover:bg-hover={!active}
    class:hover:text-default={!active}
  >
    <button
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
      onclick={() => selectTerminal(session.key)}
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        class:bg-blue={status?.running}
        class:bg-line-strong={!status?.running && status?.exitCode === undefined}
        class:bg-green={!status?.running && status?.exitCode === 0}
        class:bg-red={!status?.running && status?.exitCode !== undefined && status.exitCode !== 0}
      ></span>
      <span class="max-w-40 truncate">{session.title}</span>
    </button>
    <button
      class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
      title="Close terminal"
      onclick={() => closeTerminal(session.key)}>✕</button
    >
  </div>
{/snippet}

{#snippet newTerminalButton()}
  <button
    class="flex shrink-0 cursor-pointer items-center rounded-md p-2 text-2xs text-dim hover:bg-hover hover:text-default"
    class:self-start={sideStrip}
    title="New terminal"
    onclick={newTerminal}
  >
    ＋
  </button>
{/snippet}

<div
  class="flex h-full w-full bg-surface"
  class:flex-row={sideStrip}
  class:flex-col={!sideStrip}
  bind:clientWidth={paneWidth}
  bind:clientHeight={paneHeight}
>
  {#if !sideStrip}
    <!-- Top: tab strip of all launched terminals, like the editor buffer tabs. -->
    <div class="flex shrink-0 items-center gap-1 px-1.5 py-1">
      <div bind:this={stripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
        <div class="flex w-max items-center gap-1">
          {#each sessions as session (session.key)}
            {@render terminalTab(session)}
          {/each}
        </div>
      </div>
      {@render newTerminalButton()}
    </div>
  {/if}

  <!-- Terminal stack: only the active view is visible; the rest keep running. -->
  <div class="relative min-w-0 flex-1">
    {#each sessions as session (session.key)}
      <div class="absolute inset-0" class:hidden={session.key !== activeKey}>
        <TerminalView
          bind:this={views[session.key]}
          {leafId}
          worktreeId={session.worktreeId}
          active={session.key === activeKey}
          onExit={() => closeTerminal(session.key)}
          onTitle={(title) => setTitle(session.key, title)}
          onStatus={(status) => setStatus(session.key, status)}
        />
      </div>
    {/each}
  </div>

  {#if sideStrip}
    <!-- Right: the same terminal list as a column beside the wide terminal. -->
    <div class="flex w-44 shrink-0 flex-col gap-1 p-2">
      <div bind:this={stripEl} class="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div class="flex flex-col gap-1">
          {#each sessions as session (session.key)}
            {@render terminalTab(session)}
          {/each}
        </div>
      </div>
      {@render newTerminalButton()}
    </div>
  {/if}
</div>
