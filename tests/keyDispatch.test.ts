import { describe, it, expect } from 'bun:test'
import { KeyDispatcher, KeyPriority } from '../src/renderer/src/lib/keyDispatchCore'

// The dispatcher never reads the event, so a label is enough to trace ordering.
function keyEvent(key: string): KeyboardEvent {
  return { key } as KeyboardEvent
}

describe('KeyDispatcher', () => {
  it('runs subscribers from highest priority to lowest', () => {
    const dispatcher = new KeyDispatcher(() => null)
    const calls: string[] = []
    dispatcher.subscribe(KeyPriority.bindings, () => {
      calls.push('bindings')
      return false
    })
    dispatcher.subscribe(KeyPriority.capture, () => {
      calls.push('capture')
      return false
    })
    dispatcher.subscribe(KeyPriority.overlay, () => {
      calls.push('overlay')
      return false
    })

    dispatcher.dispatch(keyEvent('a'))

    expect(calls).toEqual(['capture', 'overlay', 'bindings'])
  })

  it('breaks priority ties by registration order', () => {
    const dispatcher = new KeyDispatcher(() => null)
    const calls: string[] = []
    dispatcher.subscribe(KeyPriority.app, () => {
      calls.push('first')
      return false
    })
    dispatcher.subscribe(KeyPriority.app, () => {
      calls.push('second')
      return false
    })

    dispatcher.dispatch(keyEvent('a'))

    expect(calls).toEqual(['first', 'second'])
  })

  it('stops the chain at the first subscriber that claims the key', () => {
    const dispatcher = new KeyDispatcher(() => null)
    const calls: string[] = []
    dispatcher.subscribe(KeyPriority.overlay, () => {
      calls.push('overlay')
      return true
    })
    dispatcher.subscribe(KeyPriority.bindings, () => {
      calls.push('bindings')
      return false
    })

    dispatcher.dispatch(keyEvent('a'))

    expect(calls).toEqual(['overlay'])
  })

  it('falls through to the focused pane sink when nothing claims the key', () => {
    const dispatcher = new KeyDispatcher(() => 'editor-1')
    const sunk: string[] = []
    dispatcher.subscribe(KeyPriority.bindings, () => false)
    dispatcher.registerPaneSink('editor-1', (event) => {
      sunk.push(event.key)
      return true
    })

    dispatcher.dispatch(keyEvent('j'))

    expect(sunk).toEqual(['j'])
  })

  it('skips the pane sink once a subscriber claims the key', () => {
    const dispatcher = new KeyDispatcher(() => 'editor-1')
    let sinkCalls = 0
    dispatcher.subscribe(KeyPriority.bindings, () => true)
    dispatcher.registerPaneSink('editor-1', () => {
      sinkCalls += 1
      return true
    })

    dispatcher.dispatch(keyEvent('j'))

    expect(sinkCalls).toBe(0)
  })

  it('only runs the sink belonging to the focused pane', () => {
    let focused = 'editor-1'
    const dispatcher = new KeyDispatcher(() => focused)
    const calls: string[] = []
    dispatcher.registerPaneSink('editor-1', () => {
      calls.push('editor-1')
      return true
    })
    dispatcher.registerPaneSink('editor-2', () => {
      calls.push('editor-2')
      return true
    })

    dispatcher.dispatch(keyEvent('j'))
    focused = 'editor-2'
    dispatcher.dispatch(keyEvent('k'))

    expect(calls).toEqual(['editor-1', 'editor-2'])
  })

  it('does nothing when the focused pane has no sink', () => {
    const dispatcher = new KeyDispatcher(() => 'terminal-1')
    let sinkCalls = 0
    dispatcher.registerPaneSink('editor-1', () => {
      sinkCalls += 1
      return true
    })

    expect(() => dispatcher.dispatch(keyEvent('c'))).not.toThrow()
    expect(sinkCalls).toBe(0)
  })

  it('stops calling a subscriber after it unsubscribes', () => {
    const dispatcher = new KeyDispatcher(() => null)
    let calls = 0
    const unsubscribe = dispatcher.subscribe(KeyPriority.bindings, () => {
      calls += 1
      return false
    })

    dispatcher.dispatch(keyEvent('a'))
    unsubscribe()
    dispatcher.dispatch(keyEvent('a'))

    expect(calls).toBe(1)
  })

  it('finishes the chain when a subscriber unsubscribes itself mid-dispatch', () => {
    const dispatcher = new KeyDispatcher(() => null)
    const calls: string[] = []
    const unsubscribe = dispatcher.subscribe(KeyPriority.dialog, () => {
      calls.push('dialog')
      unsubscribe()
      return false
    })
    dispatcher.subscribe(KeyPriority.bindings, () => {
      calls.push('bindings')
      return false
    })

    dispatcher.dispatch(keyEvent('Escape'))

    expect(calls).toEqual(['dialog', 'bindings'])
  })

  it('unregisters a pane sink without disturbing a replacement', () => {
    const dispatcher = new KeyDispatcher(() => 'editor-1')
    const calls: string[] = []
    const unregisterFirst = dispatcher.registerPaneSink('editor-1', () => {
      calls.push('first')
      return true
    })
    dispatcher.registerPaneSink('editor-1', () => {
      calls.push('second')
      return true
    })
    // The pane remounted before the old session tore down; the stale
    // unregister must not remove the live sink.
    unregisterFirst()

    dispatcher.dispatch(keyEvent('j'))

    expect(calls).toEqual(['second'])
  })
})
