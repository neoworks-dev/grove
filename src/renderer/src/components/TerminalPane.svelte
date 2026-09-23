<script lang="ts">
  // Integrated terminal panel: hosts one or more shells as tabs. Every open
  // terminal stays mounted (inactive ones hidden) so its pty keeps streaming and
  // its scrollback survives switching. A tab strip along the top — styled like
  // the editor buffer tabs — lists all launched terminals and lets the user
  // add, select, and close them.
  //
  // The shells themselves live in the terminal daemon rather than in grove, so
  // mounting starts by adopting whatever is still running in this worktree —
  // from a closed panel, or from the last time grove was open.
  //
  // The pane follows the selected worktree like the rest of the app: it lists
  // that worktree's terminals, and the others keep running hidden. Pinned, it
  // stays on one worktree whatever is selected.
  import { onMount, onDestroy, untrack } from 'svelte'
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon'
  import TerminalView from './TerminalView.svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import { claimTerminal, releaseTerminal } from '../lib/terminalClaims'
  import PaneControls from './PaneControls.svelte'

  let {
    leafId,
    state: paneState,
    updateState
  }: {
    leafId: string
    state: Record<string, unknown>
    updateState: (patch: Record<string, unknown>) => void
  } = $props()

  interface TerminalSession {
    key: string
    title: string
    worktreeId: string
    /** Set for a shell that was already running: the view attaches instead of spawning. */
    attachId?: string
    /** The daemon's id for the shell behind this tab, once it has one. */
    ptyId: string | null
  }

  // Every terminal the pane holds, across worktrees; only the shown worktree's
  // are listed.
  let sessions = $state<TerminalSession[]>([])
  // The active tab per worktree, so switching back lands where it was left.
  let activeKeyByWorktree = $state<Record<string, string>>({})
  // Worktrees whose running shells have already been adopted. Bookkeeping, not
  // state: nothing renders it.
  const adoptedWorktrees: string[] = []

  const pinnedWorktreeId = $derived(pinnedWorktree())
  const shownWorktreeId = $derived(pinnedWorktreeId || store.selectedWorktreeId)
  const shownSessions = $derived(
    sessions.filter((session) => session.worktreeId === shownWorktreeId)
  )
  const activeKey = $derived(activeKeyFor(shownWorktreeId))
  const shownWorktreeName = $derived(worktreeName(shownWorktreeId))
  const pinTitle = $derived(pinTitleFor(pinnedWorktreeId, shownWorktreeName))
  const pinWeight = $derived(pinnedWorktreeId ? 'fill' : 'regular')
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

  /**
   * Where pane navigation (ctrl+hjkl) should land inside this pane.
   *
   * In 'terminal' mode the shell is the key target, so focus has to reach
   * xterm's textarea — the pane element itself would swallow the keystrokes.
   * In 'normal' mode the pane element is the right target: that is what makes
   * the nav chords and the `i` binding below resolve, so the delegate declines.
   */
  function focusFromNavigation(): boolean {
    if (keymap.paneMode(leafId) !== 'terminal') return false
    focusActive()
    return true
  }

  /** The worktree this pane is pinned to, or an empty string when it follows the selection. */
  function pinnedWorktree(): string {
    const pinned = paneState.pinnedWorktreeId
    if (typeof pinned !== 'string') return ''
    return pinned
  }

  /** The active tab of a worktree's terminals, or null when it has none. */
  function activeKeyFor(worktreeId: string): string | null {
    const key = activeKeyByWorktree[worktreeId]
    if (!key) return null
    return key
  }

  /** The name the worktrees view shows for a worktree. */
  function worktreeName(worktreeId: string): string {
    const worktree = store.worktrees.find((candidate) => candidate.id === worktreeId)
    if (!worktree) return worktreeId
    return worktree.name
  }

  /** What the pin button does, said on hover. */
  function pinTitleFor(pinned: string, name: string): string {
    if (pinned) return `Pinned to ${name}: follow the selected worktree again`
    return `Pin to ${name}: keep these terminals when the selection changes`
  }

  /** Makes a terminal the active tab of its worktree, or leaves the worktree with none. */
  function setActiveKey(worktreeId: string, key: string | null): void {
    if (key === null) {
      delete activeKeyByWorktree[worktreeId]
      return
    }
    activeKeyByWorktree[worktreeId] = key
  }

  /** Pins the pane to the worktree it shows, or lets it follow the selection again. */
  function togglePin(): void {
    if (pinnedWorktreeId) {
      updateState({ pinnedWorktreeId: undefined })
      return
    }
    updateState({ pinnedWorktreeId: shownWorktreeId })
  }

  function newTerminal(): void {
    counter += 1
    const session: TerminalSession = {
      key: `term-${counter}`,
      title: `Terminal ${counter}`,
      worktreeId: shownWorktreeId,
      ptyId: null
    }
    sessions = [...sessions, session]
    setActiveKey(session.worktreeId, session.key)
  }

  /**
   * Adopt the shells that are still running in a worktree, once per worktree.
   * When there are none, a new one is opened only if `openWhenNone` — the pane
   * was opened to get a terminal, but browsing worktrees should not leave a
   * shell behind in each.
   *
   * The daemon owns the ptys, so a grove restart — or just closing and reopening
   * the panel — finds the same lazygit or build still going. Terminals another
   * pane has already taken are left alone.
   */
  async function adoptTerminals(worktreeId: string, openWhenNone: boolean): Promise<void> {
    if (adoptedWorktrees.includes(worktreeId)) return
    adoptedWorktrees.push(worktreeId)
    const running = await window.workbench.terminal.list().catch(() => [])
    const mine = running
      .filter((info) => info.worktreeId === worktreeId)
      .filter((info) => claimTerminal(info.id))
      .sort((a, b) => a.startedAt - b.startedAt)

    if (mine.length === 0) {
      if (openWhenNone && worktreeId === shownWorktreeId) newTerminal()
      return
    }
    const adopted = mine.map((info) => ({
      key: info.id,
      title: info.title,
      worktreeId,
      attachId: info.id,
      ptyId: info.id
    }))
    sessions = [...sessions, ...adopted]
    if (!activeKeyFor(worktreeId)) setActiveKey(worktreeId, adopted[0].key)
  }

  /** A view reports the shell it ended up with, which is what close kills. */
  function bindSession(key: string, ptyId: string): void {
    claimTerminal(ptyId)
    sessions = sessions.map((session) => {
      if (session.key !== key) return session
      return { ...session, ptyId }
    })
  }

  // Name each terminal after its running foreground process (falls back to the
  // static "Terminal N" until the first sample arrives).
  function setTitle(key: string, title: string): void {
    sessions = sessions.map((session) => (session.key === key ? { ...session, title } : session))
  }

  function selectTerminal(key: string): void {
    const session = sessions.find((candidate) => candidate.key === key)
    if (!session) return
    setActiveKey(session.worktreeId, key)
    // Defer focus until the newly-shown view has laid out.
    requestAnimationFrame(() => views[key]?.focus())
  }

  // Remove a terminal from the panel, and end the shell with it: closing a tab
  // is the one way a terminal dies now that quitting grove no longer does it.
  // Closing the last one the pane holds closes the whole pane; closing the last
  // one of a worktree leaves it empty.
  function closeTerminal(key: string): void {
    const closing = sessions.find((session) => session.key === key)
    if (!closing) return
    if (closing.ptyId) {
      void window.workbench.terminal.kill(closing.ptyId)
      releaseTerminal(closing.ptyId)
    }
    delete views[key]
    const siblings = sessions.filter((session) => session.worktreeId === closing.worktreeId)
    const index = siblings.indexOf(closing)
    sessions = sessions.filter((session) => session.key !== key)
    if (sessions.length === 0) {
      layout.closeLeaf(leafId)
      return
    }
    if (activeKeyFor(closing.worktreeId) === key) selectNeighbor(closing.worktreeId, index)
  }

  /** Activates the tab that took a closed one's place in its worktree, if any is left. */
  function selectNeighbor(worktreeId: string, closedIndex: number): void {
    const remaining = sessions.filter((session) => session.worktreeId === worktreeId)
    if (remaining.length === 0) {
      setActiveKey(worktreeId, null)
      return
    }
    const neighbor = remaining[Math.min(closedIndex, remaining.length - 1)]
    selectTerminal(neighbor.key)
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
  let unregisterFocus: (() => void) | null = null

  // Follow the shown worktree: the first time it comes up, adopt what is still
  // running there. The worktree shown at mount is the one the pane was opened
  // for, so it gets a fresh shell when it has none.
  let mounted = false
  $effect(() => {
    const worktreeId = shownWorktreeId
    if (!worktreeId) return
    const openWhenNone = !mounted
    mounted = true
    untrack(() => void adoptTerminals(worktreeId, openWhenNone))
  })

  onMount(() => {
    unregisterFocus = keymap.registerPaneFocus(leafId, focusFromNavigation)
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

  // The pane going away leaves the shells running — that is the point of the
  // daemon — so its claims are handed back for the next pane to adopt.
  onDestroy(() => {
    unregisterBindings?.()
    unregisterFocus?.()
    for (const session of sessions) {
      if (session.ptyId) releaseTerminal(session.ptyId)
    }
  })
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

{#snippet pinButton()}
  <!-- Pinned, the pane names the worktree it stays on; the tabs alone would not
       say that they are not the selected worktree's. -->
  <button
    class="flex max-w-40 shrink-0 cursor-pointer items-center gap-1 rounded-md p-2 text-2xs hover:bg-hover hover:text-default"
    class:self-start={sideStrip}
    class:text-blue={pinnedWorktreeId}
    class:text-dim={!pinnedWorktreeId}
    title={pinTitle}
    onclick={togglePin}
  >
    <PushPinIcon size={12} weight={pinWeight} />
    {#if pinnedWorktreeId}
      <span class="truncate">{shownWorktreeName}</span>
    {/if}
  </button>
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
          {#each shownSessions as session (session.key)}
            {@render terminalTab(session)}
          {/each}
        </div>
      </div>
      {@render pinButton()}
      {@render newTerminalButton()}
      <PaneControls />
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
          attachId={session.attachId}
          active={session.key === activeKey}
          onSession={(ptyId) => bindSession(session.key, ptyId)}
          onExit={() => closeTerminal(session.key)}
          onTitle={(title) => setTitle(session.key, title)}
          onStatus={(status) => setStatus(session.key, status)}
        />
      </div>
    {/each}
    {#if shownSessions.length === 0}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3">
        <p class="text-xs text-dim">No terminal in {shownWorktreeName}.</p>
        <button class="rounded-md bg-action px-3 py-1 text-xs text-action-fg" onclick={newTerminal}>
          New terminal
        </button>
      </div>
    {/if}
  </div>

  {#if sideStrip}
    <!-- Right: the same terminal list as a column beside the wide terminal. -->
    <div class="flex w-44 shrink-0 flex-col gap-1 p-2">
      <PaneControls class="self-end" />
      <div bind:this={stripEl} class="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div class="flex flex-col gap-1">
          {#each shownSessions as session (session.key)}
            {@render terminalTab(session)}
          {/each}
        </div>
      </div>
      {@render pinButton()}
      {@render newTerminalButton()}
    </div>
  {/if}
</div>
