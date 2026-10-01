<script lang="ts">
  // The Debug Console: what the program and the adapter print, and a prompt
  // that evaluates in the focused frame. Results with structure expand in place.
  import { tick } from 'svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import type { DebugOutputLine } from '../../../../../shared/debug'
  import RowAction from '../gitChanges/RowAction.svelte'
  import VariableNode from './VariableNode.svelte'
  import { debug } from './store.svelte'

  let draft = $state('')
  let history = $state<string[]>([])
  let historyIndex = $state(-1)
  let viewport = $state<HTMLDivElement>()
  let stickToBottom = true

  const lines = $derived(debug.output)

  // New output scrolls into view unless the user scrolled up to read.
  $effect(() => {
    void lines.length
    if (stickToBottom) {
      void tick().then(() => viewport?.scrollTo({ top: viewport.scrollHeight }))
    }
  })

  /** Remembers whether the view sits at the bottom, so output keeps following it. */
  function onScroll(): void {
    if (!viewport) {
      return
    }
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    stickToBottom = distance < 24
  }

  function colourOf(line: DebugOutputLine): string {
    if (line.category === 'stderr' || line.category === 'error') {
      return 'text-red'
    }
    if (line.category === 'important') {
      return 'text-amber'
    }
    if (line.category === 'input') {
      return 'text-blue'
    }
    if (line.category === 'console') {
      return 'text-dim'
    }
    return 'text-default'
  }

  /** Enter evaluates; Up and Down walk earlier input. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      submit()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      recall(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      recall(-1)
    }
  }

  function submit(): void {
    const expression = draft.trim()
    if (expression === '') {
      return
    }
    history = [expression, ...history.filter((entry) => entry !== expression)]
    historyIndex = -1
    draft = ''
    stickToBottom = true
    void debug.evaluateInConsole(expression)
  }

  /** Steps through input history; -1 is the empty prompt. */
  function recall(step: number): void {
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + step))
    historyIndex = next
    if (next === -1) {
      draft = ''
      return
    }
    draft = history[next]
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface">
  <div class="flex h-7 shrink-0 items-center gap-2 px-3">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Debug Console</span>
    <span class="flex-1"></span>
    <RowAction
      icon={TrashIcon}
      title="Clear console"
      onclick={() => void window.workbench.debugger.clearOutput()}
    />
  </div>
  <FloatingScrollbar class="min-h-0 flex-1" bind:viewport onscroll={onScroll}>
    <div class="px-3 py-1 font-mono text-xs">
      {#each lines as line (line.sequence)}
        {#if line.category === 'result' && line.variablesReference && line.sessionId}
          <div class="-ml-2">
            <VariableNode
              sessionId={line.sessionId}
              name={line.text.trimEnd()}
              variablesReference={line.variablesReference}
              heading
            />
          </div>
        {:else}
          <div class="whitespace-pre-wrap break-words {colourOf(line)}">
            {#if line.category === 'input'}<span class="text-dim">› </span>{/if}{line.text.replace(
              /\n$/,
              ''
            )}
          </div>
        {/if}
      {/each}
    </div>
  </FloatingScrollbar>
  <div class="flex shrink-0 items-center gap-1 border-t border-line px-2">
    <span class="text-blue"><CaretRightIcon size={11} /></span>
    <input
      class="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs text-default outline-none placeholder:text-faint"
      placeholder={debug.stopped
        ? 'Evaluate in the paused frame'
        : 'Evaluate (start debugging first)'}
      aria-label="Evaluate expression"
      bind:value={draft}
      onkeydown={onKeydown}
    />
  </div>
</div>
