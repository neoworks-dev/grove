// Loading the pane's reference data once. This exists because the obvious
// version — "fetch if the list is still empty" — decides before the answer is
// back, so every component that mounts in the same tick fetches too. These
// tests are the ones that would have caught that.

import { describe, it, expect } from 'bun:test'
import {
  clearRefusals,
  loadOnce,
  newReferenceLoads
} from '../src/renderer/src/kernel/plugins/github/referenceLoads'

/** A load that stays in flight until the test lets it finish. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('loadOnce', () => {
  it('runs the load', async () => {
    const loads = newReferenceLoads()
    let ran = 0
    await loadOnce(
      loads,
      'labels',
      async () => void ran++,
      () => {}
    )
    expect(ran).toBe(1)
  })

  // The reported failure: three menus mount together, all see an empty list,
  // all fetch. Two identical requests reached GitHub in the same second.
  it('does not start a second load while the first is in flight', async () => {
    const loads = newReferenceLoads()
    const gate = deferred()
    let started = 0
    const load = (): Promise<void> => {
      started += 1
      return gate.promise
    }

    const first = loadOnce(loads, 'labels', load, () => {})
    const second = loadOnce(loads, 'labels', load, () => {})
    const third = loadOnce(loads, 'labels', load, () => {})
    expect(started).toBe(1)

    gate.resolve()
    await Promise.all([first, second, third])
    expect(started).toBe(1)
  })

  it('lets a later caller load again once the first one is done', async () => {
    const loads = newReferenceLoads()
    let started = 0
    const load = async (): Promise<void> => void started++

    await loadOnce(loads, 'labels', load, () => {})
    await loadOnce(loads, 'labels', load, () => {})
    // Succeeding is the store's job to remember, by having the data; this only
    // promises not to run two at the same time.
    expect(started).toBe(2)
  })

  it('keeps separate keys apart', async () => {
    const loads = newReferenceLoads()
    const started: string[] = []
    const gate = deferred()
    void loadOnce(
      loads,
      'labels',
      () => {
        started.push('labels')
        return gate.promise
      },
      () => {}
    )
    void loadOnce(
      loads,
      'milestones',
      () => {
        started.push('milestones')
        return gate.promise
      },
      () => {}
    )
    expect(started).toEqual(['labels', 'milestones'])
    gate.resolve()
  })

  it('reports a failure once and does not ask again', async () => {
    const loads = newReferenceLoads()
    let started = 0
    const reported: string[] = []
    const load = async (): Promise<void> => {
      started += 1
      throw new Error('GitHub rate limit: Grove asked too quickly.')
    }

    await loadOnce(loads, 'milestones', load, (error) => reported.push(error.message))
    await loadOnce(loads, 'milestones', load, (error) => reported.push(error.message))
    await loadOnce(loads, 'milestones', load, (error) => reported.push(error.message))

    // The whole point: a refusal must not turn into a retry on every remount,
    // which is what keeps a transient rate limit alive.
    expect(started).toBe(1)
    expect(reported).toEqual(['GitHub rate limit: Grove asked too quickly.'])
  })

  it('does not swallow the failure into the caller', async () => {
    const loads = newReferenceLoads()
    const load = async (): Promise<void> => {
      throw new Error('nope')
    }
    // Resolves rather than rejecting: a component effect has nowhere to put a
    // rejection, and the error has already been reported through onError.
    await expect(loadOnce(loads, 'labels', load, () => {})).resolves.toBeUndefined()
  })

  it('refuses one key without refusing the others', async () => {
    const loads = newReferenceLoads()
    await loadOnce(
      loads,
      'milestones',
      async () => {
        throw new Error('nope')
      },
      () => {}
    )

    let ran = 0
    await loadOnce(
      loads,
      'labels',
      async () => void ran++,
      () => {}
    )
    expect(ran).toBe(1)
    expect(loads.refused).toEqual(['milestones'])
  })
})

describe('clearRefusals', () => {
  it('lets a refused load be asked for again', async () => {
    const loads = newReferenceLoads()
    let started = 0
    const load = async (): Promise<void> => {
      started += 1
      throw new Error('nope')
    }

    await loadOnce(loads, 'milestones', load, () => {})
    await loadOnce(loads, 'milestones', load, () => {})
    expect(started).toBe(1)

    clearRefusals(loads)
    await loadOnce(loads, 'milestones', load, () => {})
    expect(started).toBe(2)
  })
})
