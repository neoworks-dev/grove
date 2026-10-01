<script lang="ts">
  // The focused frame's scopes and their variables. Reloaded whenever the
  // focused frame changes or the program stops again.
  import type { DebugScope } from '../../../../../shared/debug'
  import DebugSection from './DebugSection.svelte'
  import VariableNode from './VariableNode.svelte'
  import { debug, messageOf } from './store.svelte'

  let scopes = $state<DebugScope[]>([])
  let loadError = $state<string | null>(null)

  const session = $derived(debug.focusedSession)
  const frameId = $derived(debug.snapshot.focusedFrameId)
  // Changes on every stop and every frame pick: the key the tree reloads on.
  const reloadKey = $derived(`${debug.snapshot.stopSequence}:${frameId}`)

  $effect(() => {
    void reloadKey
    void loadScopes(session?.id, session?.state, frameId)
  })

  /** Loads the scopes of the focused frame, or clears them when nothing is stopped. */
  async function loadScopes(
    sessionId: string | undefined,
    state: string | undefined,
    frame: number | null
  ): Promise<void> {
    loadError = null
    if (!sessionId || state !== 'stopped' || frame === null) {
      scopes = []
      return
    }
    try {
      scopes = await window.workbench.debugger.scopes(sessionId, frame)
    } catch (error) {
      loadError = messageOf(error)
      scopes = []
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
    {#key reloadKey}
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
