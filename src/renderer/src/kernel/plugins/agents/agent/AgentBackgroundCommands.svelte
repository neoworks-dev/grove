<script lang="ts">
  // The session's commands still running in the background, between the
  // composer and its controls. Their calls have returned, so this is the one
  // place left to stop them.
  //
  // Folded to a count. ArrowDown from the composer lands here; Enter opens the
  // list, the arrows move through it, x stops the command picked, and ArrowUp
  // from the top or Escape goes back.
  import { onDestroy } from 'svelte'
  import { backgroundCommandsOf } from '../../../../lib/agents/backgroundCommands'
  import { shellOutputs } from '../../../../lib/agents/shellOutput.svelte'
  import { agentTerminal } from '../../../../lib/agents/agentTerminal.svelte'
  import type { TranscriptItem } from '../../../../lib/agents/transcript'
  import { keyDispatch, KeyPriority } from '../../../../lib/keyDispatch'

  let {
    sessionId,
    items,
    onLeave
  }: {
    sessionId: string
    items: TranscriptItem[]
    /** Hand the keyboard back to the composer. */
    onLeave: () => void
  } = $props()

  const commands = $derived(backgroundCommandsOf(items, shellOutputs.forSession(sessionId)))

  let rootEl = $state<HTMLDivElement>()
  let expanded = $state(false)
  let focused = $state(false)
  // -1 is the count row; 0 and up are the commands under it.
  let selected = $state(-1)

  // A list emptied while open starts folded next time.
  $effect(() => {
    if (commands.length > 0) return
    expanded = false
    selected = -1
  })

  /**
   * Notes focus leaving the list, unless it only moved to one of the list's own
   * buttons. When it left because the last command ended and the list went
   * away under it, the keyboard goes back to the composer rather than nowhere.
   */
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && rootEl?.contains(next)) return
    focused = false
    if (next === null && commands.length === 0) queueMicrotask(onLeave)
  }

  // Keep the pick on a command that is still there once one exits.
  $effect(() => {
    if (selected >= commands.length) selected = commands.length - 1
  })

  /** Takes the keyboard, on the count row. False when there is nothing to show. */
  export function focus(): boolean {
    if (!rootEl || commands.length === 0) return false
    selected = -1
    rootEl.focus()
    return document.activeElement === rootEl
  }

  /** Opens or folds the list. */
  function toggle(): void {
    expanded = !expanded
    selected = -1
  }

  /** Stops the command at `index`, as Ctrl+C would. */
  function stop(index: number): void {
    const command = commands[index]
    if (!command) return
    shellOutputs.interrupt(sessionId, command.id)
  }

  /** Moves the pick up, leaving for the composer from the count row. */
  function moveUp(): void {
    if (selected === -1) {
      onLeave()
      return
    }
    selected -= 1
  }

  /** Moves the pick down through an open list. */
  function moveDown(): void {
    if (!expanded) return
    selected = Math.min(selected + 1, commands.length - 1)
  }

  /** Escape folds an open list first, and leaves from a folded one. */
  function escape(): void {
    if (!expanded) {
      onLeave()
      return
    }
    expanded = false
    selected = -1
  }

  /** Enter on the count row opens or folds the list; on a command, shows it in the agent terminal. */
  function enter(): void {
    if (selected === -1) {
      toggle()
      return
    }
    const command = commands[selected]
    if (command) agentTerminal.show(sessionId, command.id)
  }

  const KEY_ACTIONS: Record<string, () => void> = {
    ArrowUp: moveUp,
    ArrowDown: moveDown,
    Enter: enter,
    Escape: escape,
    x: () => stop(selected)
  }

  /**
   * Claims the list's keys while it has focus. Through the dispatcher rather
   * than an element listener: the pane's bare-key bindings run in the capture
   * phase and would take x and the rest first.
   */
  function onKey(event: KeyboardEvent): boolean {
    if (!focused || event.ctrlKey || event.altKey || event.metaKey) return false
    const action = KEY_ACTIONS[event.key]
    if (!action) return false
    event.preventDefault()
    event.stopPropagation()
    action()
    return true
  }

  const unsubscribe = keyDispatch.subscribe(KeyPriority.menu, onKey)
  onDestroy(unsubscribe)
</script>

{#if commands.length > 0}
  <div
    bind:this={rootEl}
    class="mt-1.5 rounded-md border border-line bg-elevated text-2xs text-muted outline-none focus:border-accent"
    tabindex="-1"
    role="listbox"
    aria-label="Background tasks"
    onfocusin={() => (focused = true)}
    onfocusout={onFocusOut}
  >
    <button
      class="flex w-full items-center gap-2 px-2 py-1 text-left hover:text-default"
      class:bg-hover={focused && selected === -1}
      tabindex="-1"
      aria-expanded={expanded}
      onclick={() => {
        toggle()
        rootEl?.focus()
      }}
    >
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-green" aria-hidden="true"></span>
      <span class="min-w-0 flex-1 truncate">
        {commands.length} background {commands.length === 1 ? 'task' : 'tasks'}
      </span>
      <span class="shrink-0 text-dim">{expanded ? '▾' : '▸'}</span>
    </button>
    {#if expanded}
      <div class="flex max-h-32 flex-col overflow-auto border-t border-line py-0.5">
        {#each commands as command, index (command.id)}
          <div
            class="flex items-center gap-2 px-2 py-0.5"
            class:bg-hover={focused && selected === index}
            class:text-default={focused && selected === index}
            role="option"
            aria-selected={selected === index}
          >
            <button
              class="min-w-0 flex-1 truncate text-left font-mono hover:text-default"
              tabindex="-1"
              title="Show it in the agent terminal (Enter)"
              onclick={() => agentTerminal.show(sessionId, command.id)}
            >
              {command.command}
            </button>
            {#if command.waitingForInput}
              <span class="shrink-0 text-amber">waiting for input</span>
            {/if}
            <button
              class="shrink-0 text-dim hover:text-red"
              tabindex="-1"
              title="Stop the command (x)"
              onclick={() => stop(index)}>✕</button
            >
          </div>
        {/each}
      </div>
      {#if focused}
        <div class="border-t border-line px-2 py-0.5 text-dim">↑↓ pick · enter show · x stop · esc close</div>
      {/if}
    {/if}
  </div>
{/if}
