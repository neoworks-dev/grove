import { describe, it, expect } from 'bun:test'
import { EventHub } from '../src/main/api/events'

describe('EventHub', () => {
  it('delivers exact-topic and prefix subscriptions', () => {
    const hub = new EventHub()
    const exact: string[] = []
    const prefixed: string[] = []
    hub.subscribe(['git.didChangeStatus'], (event) => exact.push(event.topic))
    hub.subscribe(['git.'], (event) => prefixed.push(event.topic))
    hub.publish({ topic: 'git.didChangeStatus', payload: {} })
    hub.publish({ topic: 'git.didSomethingElse', payload: {} })
    hub.publish({ topic: 'editor.didChangeDocument', payload: {} })
    expect(exact).toEqual(['git.didChangeStatus'])
    expect(prefixed).toEqual(['git.didChangeStatus', 'git.didSomethingElse'])
  })

  it('unsubscribe stops delivery', () => {
    const hub = new EventHub()
    const seen: string[] = []
    const unsubscribe = hub.subscribe(['files.didChange'], (event) => seen.push(event.topic))
    hub.publish({ topic: 'files.didChange', payload: {} })
    unsubscribe()
    hub.publish({ topic: 'files.didChange', payload: {} })
    expect(seen).toHaveLength(1)
  })

  it('maps topics to required scopes by prefix in both directions', () => {
    const hub = new EventHub()
    hub.registerTopicScope('git.', 'git.read')
    hub.registerTopicScope('editor.', 'editor.read')
    expect(hub.scopesFor(['git.didChangeStatus'])).toEqual(['git.read'])
    expect(hub.scopesFor(['git.'])).toEqual(['git.read'])
    // Subscribing to everything requires every registered scope.
    expect(hub.scopesFor(['']).sort()).toEqual(['editor.read', 'git.read'])
    expect(hub.scopesFor(['files.didChange'])).toEqual([])
  })
})
