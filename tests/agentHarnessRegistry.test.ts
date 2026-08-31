// The harness registry is what makes a new coding agent a plugin rather than a
// fork of the session service. This pins the two properties that depend on:
// registration is revertible, and a session naming an unmounted harness fails
// loudly instead of silently running the wrong one.

import { describe, expect, test } from 'bun:test'
import { HarnessRegistry, type HarnessDescriptor } from '../src/main/agents/harness'

function descriptor(id: string, available = true): HarnessDescriptor {
  return {
    id,
    label: id,
    description: '',
    icon: 'grove:test',
    capabilities: {
      approvals: true,
      interrupt: true,
      liveModelSwitch: true,
      thinking: true,
      steering: true,
      groveTools: true
    },
    probe: async () => ({ available, detail: available ? null : 'not installed' }),
    offering: async () => ({
      tools: [],
      commands: [],
      skills: [],
      providers: [],
      default: null
    }),
    start: async () => {
      throw new Error('not started in this test')
    },
    intentOf: () => null
  }
}

describe('HarnessRegistry', () => {
  test('registering hands back the inverse', () => {
    const registry = new HarnessRegistry()
    const dispose = registry.register(descriptor('claude'))
    expect(registry.ids()).toEqual(['claude'])

    dispose()
    expect(registry.ids()).toEqual([])
  })

  test('two harnesses cannot claim the same id', () => {
    const registry = new HarnessRegistry()
    registry.register(descriptor('pi'))
    expect(() => registry.register(descriptor('pi'))).toThrow('harness already registered: pi')
  })

  test('requiring an unmounted harness names what is mounted', () => {
    const registry = new HarnessRegistry()
    registry.register(descriptor('claude'))
    expect(() => registry.require('codex')).toThrow('unknown harness "codex" (mounted: claude)')
  })

  test('describe reports availability from the probe', async () => {
    const registry = new HarnessRegistry()
    registry.register(descriptor('claude'))
    registry.register(descriptor('codex', false))

    const described = await registry.describe()
    expect(described.map((harness) => [harness.id, harness.available])).toEqual([
      ['claude', true],
      ['codex', false]
    ])
    expect(described[1].detail).toBe('not installed')
  })

  test('a probe that throws is a harness that cannot run, not a crash', async () => {
    const registry = new HarnessRegistry()
    const failing = descriptor('pi')
    failing.probe = async () => {
      throw new Error('no credentials')
    }
    registry.register(failing)

    const [described] = await registry.describe()
    expect(described.available).toBe(false)
    expect(described.detail).toBe('no credentials')
  })
})
