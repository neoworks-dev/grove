<script lang="ts">
  // Watch expressions, kept per repository by the main process, evaluated in
  // the focused frame each time the program stops.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import type { DebugEvaluation } from '../../../../../shared/debug'
  import DebugSection from './DebugSection.svelte'
  import VariableNode from './VariableNode.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { debug } from './store.svelte'
  import { messageOf } from './messages'

  type WatchResult = { evaluation: DebugEvaluation } | { error: string }

  let results = $state<Record<string, WatchResult>>({})
  let adding = $state(false)
  let draft = $state('')
  let open = $state(true)

  const session = $derived(debug.focusedSession)
  const watches = $derived(debug.snapshot.watches)
  const reloadKey = $derived(`${debug.snapshot.stopSequence}:${debug.snapshot.focusedFrameId}`)

  $effect(() => {
    void reloadKey
    void evaluateAll(watches, session?.id, session?.state)
  })

  /** Evaluates every watch in the focused frame, or clears them with nothing paused. */
  async function evaluateAll(
    expressions: string[],
    sessionId: string | undefined,
    state: string | undefined
  ): Promise<void> {
    if (!sessionId || state !== 'stopped') {
      results = {}
      return
    }
    const next: Record<string, WatchResult> = {}
    for (const expression of expressions) {
      next[expression] = await evaluate(expression, sessionId)
    }
    results = next
  }

  async function evaluate(expression: string, sessionId: string): Promise<WatchResult> {
    try {
      return {
        evaluation: await window.workbench.debugger.evaluate(expression, 'watch', sessionId)
      }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  /** Shows the input for a new watch. */
  function startAdding(): void {
    open = true
    adding = true
    draft = ''
  }

  /** Enter adds the typed expression; Escape gives up. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      adding = false
      return
    }
    if (event.key !== 'Enter') {
      return
    }
    const expression = draft.trim()
    adding = false
    if (expression !== '') {
      void window.workbench.debugger.addWatch(expression)
    }
  }

  /** Focuses the input as it appears. */
  function autofocus(element: HTMLInputElement): void {
    element.focus()
  }
</script>

<DebugSection title="Watch" count={watches.length} bind:open>
  {#snippet actions()}
    <RowAction icon={PlusIcon} title="Add a watch expression" onclick={startAdding} />
  {/snippet}
  <!-- Re-keyed on each evaluation, so an expanded result never shows a stop's old children. -->
  {#key results}
    {#each watches as expression (expression)}
      {@const result = results[expression]}
      <div class="group/watch relative">
        {#if result && 'evaluation' in result && session}
          <VariableNode
            sessionId={session.id}
            name={expression}
            value={result.evaluation.result}
            type={result.evaluation.type}
            variablesReference={result.evaluation.variablesReference}
          />
        {:else}
          <div class="flex h-5 items-center gap-1 pl-6 pr-7 font-mono text-xs">
            <span class="shrink-0 text-violet">{expression}</span>
            {#if result && 'error' in result}
              <span class="min-w-0 truncate text-dim" title={result.error}>= {result.error}</span>
            {/if}
          </div>
        {/if}
        <div class="absolute right-1 top-0.5 hidden group-hover/watch:block">
          <RowAction
            icon={XIcon}
            title="Remove watch"
            onclick={() => void window.workbench.debugger.removeWatch(expression)}
          />
        </div>
      </div>
    {/each}
  {/key}
  {#if adding}
    <input
      class="mx-2 my-0.5 w-[calc(100%-1rem)] rounded border border-line bg-input px-2 py-0.5 font-mono text-xs text-default outline-none focus:border-line-strong"
      placeholder="Expression to watch"
      bind:value={draft}
      onkeydown={onKeydown}
      onblur={() => (adding = false)}
      use:autofocus
    />
  {:else if watches.length === 0}
    <p class="px-3 py-1 text-2xs text-dim">No watch expressions.</p>
  {/if}
</DebugSection>
