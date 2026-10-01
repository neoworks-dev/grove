<script lang="ts">
  // The focused frame's scopes and their variables. Reloaded whenever the
  // focused frame changes or the program stops again.
  import { untrack } from 'svelte'
  import type { DebugScope } from '../../../../../shared/debug'
  import DebugSection from './DebugSection.svelte'
  import VariableNode from './VariableNode.svelte'
  import { debug, messageOf } from './store.svelte'

  /** Scopes, with the stop and frame they were loaded for. */
  let loaded = $state<{ key: string; scopes: DebugScope[] } | null>(null)
  let loadError = $state<string | null>(null)

  const session = $derived(debug.focusedSession)
  // What the tree shows: a session, a stop and a frame. Null with nothing paused.
  const target = $derived.by(() => {
    const frameId = debug.snapshot.focusedFrameId
    if (!session || session.state !== 'stopped' || frameId === null) {
      return null
    }
    return {
      key: `${session.id}:${debug.snapshot.stopSequence}:${frameId}`,
      sessionId: session.id,
      frameId
    }
  })
  const targetKey = $derived(target?.key)
  // Scopes from an earlier stop are never drawn: their references may be gone.
  const scopes = $derived.by(() => {
    if (!loaded || loaded.key !== targetKey) {
      return []
    }
    return loaded.scopes
  })

  $effect(() => {
    void targetKey
    void loadScopes()
  })

  /** Loads the scopes of the focused frame, or clears them when nothing is paused. */
  async function loadScopes(): Promise<void> {
    // Only the key decides when to reload; the target object is new on every snapshot.
    const current = untrack(() => target)
    loadError = null
    if (!current) {
      loaded = null
      return
    }
    try {
      const fetched = await window.workbench.debugger.scopes(current.sessionId, current.frameId)
      loaded = { key: current.key, scopes: fetched }
    } catch (error) {
      loadError = messageOf(error)
    }
  }

  /** Opens the first scope that is cheap to load, the way most debuggers do. */
  function opensByDefault(scope: DebugScope, index: number): boolean {
    const firstCheap = scopes.findIndex((candidate) => !candidate.expensive)
    return index === firstCheap && !scope.expensive
  }
</script>

<DebugSection title="Variables">
  {#if loadError}
    <p class="px-3 py-1 text-2xs text-red">{loadError}</p>
  {:else if !session || session.state !== 'stopped'}
    <p class="px-3 py-1 text-2xs text-dim">Variables show here when the program is paused.</p>
  {:else}
    {#key targetKey}
      {#each scopes as scope, index (scope.name)}
        <VariableNode
          sessionId={session.id}
          name={scope.name}
          variablesReference={scope.variablesReference}
          expanded={opensByDefault(scope, index)}
          heading
        />
      {/each}
    {/key}
  {/if}
</DebugSection>
