import { describe, it, expect } from 'bun:test'
import {
  resolveDefaultBindings,
  readCustomBindings,
  readOverrideMap,
  actionHash
} from '../src/renderer/src/lib/bindingResolution'

const defaults = [
  { id: 'leader.files', keys: 'leader space' },
  { id: 'pane.focus.h', keys: 'ctrl+h' }
]

describe('resolveDefaultBindings', () => {
  it('keeps defaults untouched without overrides', () => {
    const resolved = resolveDefaultBindings(defaults, {}, {})
    expect(resolved).toHaveLength(2)
    expect(resolved[0].source).toBe('default')
    expect(resolved[0].keys).toBe('leader space')
  })

  it('applies user overrides and lets project win', () => {
    const resolved = resolveDefaultBindings(
      defaults,
      { 'leader.files': 'leader f f' },
      { 'leader.files': 'leader o' }
    )
    const entry = resolved.find((item) => item.id === 'leader.files')
    expect(entry?.keys).toBe('leader o')
    expect(entry?.source).toBe('project')
  })

  it('marks null overrides as unbound but keeps them listed', () => {
    const resolved = resolveDefaultBindings(defaults, { 'pane.focus.h': null }, {})
    const entry = resolved.find((item) => item.id === 'pane.focus.h')
    expect(entry?.unbound).toBe(true)
    expect(entry?.source).toBe('user')
  })

  it('drops overrides with invalid sequences', () => {
    const resolved = resolveDefaultBindings(defaults, { 'pane.focus.h': 'bogus+key' }, {})
    expect(resolved.find((item) => item.id === 'pane.focus.h')).toBeUndefined()
  })
})

describe('readCustomBindings / readOverrideMap', () => {
  it('parses well-formed custom bindings and skips malformed ones', () => {
    const raw = [
      {
        id: 'custom.1',
        keys: 'leader a b',
        description: 'Run tests',
        action: { type: 'shell', commandLine: 'bun test' }
      },
      { id: 'custom.2', keys: 'not a+key', description: 'bad', action: { type: 'shell' } },
      { id: 42 }
    ]
    const parsed = readCustomBindings(raw, 'custom-user')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].binding.id).toBe('custom.1')
    expect(parsed[0].sequence.leader).toBe(true)
  })

  it('ignores non-array custom values and non-object override maps', () => {
    expect(readCustomBindings('nope', 'custom-user')).toHaveLength(0)
    expect(readOverrideMap([1, 2])).toEqual({})
    expect(readOverrideMap({ a: 'leader x', b: null, c: 42 })).toEqual({ a: 'leader x', b: null })
  })
})

describe('actionHash', () => {
  it('is stable and input-sensitive', () => {
    expect(actionHash('shell:bun test')).toBe(actionHash('shell:bun test'))
    expect(actionHash('shell:bun test')).not.toBe(actionHash('shell:rm -rf /'))
  })
})
