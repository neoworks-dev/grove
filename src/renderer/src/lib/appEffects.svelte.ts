// App-wide reactive bookkeeping that belongs to no component.
//
// It lives here rather than in main.ts because runes only compile inside
// `.svelte` and `.svelte.ts` files; `$effect.root` in a plain module throws
// `rune_outside_svelte` at startup and takes everything after it with it.

import { store, syncWatched } from './store.svelte'
import { intro } from './intro.svelte'

/** Start the effects. Returns the teardown, which only a reload would use. */
export function startAppEffects(): () => void {
  return $effect.root(() => {
    // An agent starting or finishing in an unselected worktree changes what has
    // to be watched for file changes, and that is learned from polling the
    // session list rather than from an event — so follow it reactively.
    $effect(() => {
      void store.activeAgentWorktrees.length
      syncWatched()
    })

    // The onboarding agent reports its phase as a surface on its own stream, so
    // the stepper follows the transcript rather than an event.
    $effect(() => {
      intro.syncPhase()
    })
  })
}
