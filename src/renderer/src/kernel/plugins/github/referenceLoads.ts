// Loading the pane's reference data — the repository's labels, its milestones,
// the people it can assign — exactly once.
//
// "Once" cannot be decided by looking at the result. The check runs before the
// request comes back, so three menus mounting in the same tick all see an empty
// list and all fetch: two identical requests in the same second is how this
// turned up, against a repository busy enough for GitHub to refuse the burst.
// What is in flight has to be tracked instead.
//
// Failure is tracked for a sharper reason. "Have not got it" and "asked and was
// refused" are different states, and a loader that cannot tell them apart
// retries on every remount — which is how a rate limit that would have cleared
// on its own becomes one that never does.
//
// Kept out of the store so it can be tested without runes.

export interface ReferenceLoads {
  /** Key to the request already running for it, if there is one. */
  inFlight: Record<string, Promise<void> | undefined>
  /** Keys whose load failed and should not be tried again unasked. */
  refused: string[]
}

export function newReferenceLoads(): ReferenceLoads {
  return { inFlight: {}, refused: [] }
}

/**
 * Run a load at most once. A caller arriving while it is in flight waits on the
 * same request rather than starting another; a caller arriving after it failed
 * does nothing at all until the refusals are cleared.
 */
export function loadOnce(
  loads: ReferenceLoads,
  key: string,
  load: () => Promise<void>,
  onError: (error: Error) => void
): Promise<void> {
  const running = loads.inFlight[key]
  if (running) return running
  if (loads.refused.includes(key)) return Promise.resolve()

  const started = load()
    .catch((error) => {
      loads.refused.push(key)
      onError(error as Error)
    })
    .finally(() => {
      loads.inFlight[key] = undefined
    })
  loads.inFlight[key] = started
  return started
}

/** Let the refused loads be asked for again. */
export function clearRefusals(loads: ReferenceLoads): void {
  loads.refused = []
}
