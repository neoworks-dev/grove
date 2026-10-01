import { describe, expect, test } from 'bun:test'
import { choiceOf, spawnInputFor } from '../src/renderer/src/lib/agents/spawnChoice'
import type { SpawnTarget } from '../src/shared/agents'

const target: SpawnTarget = {
  harness: 'claude',
  provider: 'anthropic',
  model: 'default',
  modelIsDefault: true,
  modelDescription: 'Opus (1M context)',
  effort: null
}

const input = { title: 'Reviewer', prompt: 'review it' }

describe("a spawn's approval", () => {
  test('runs the call as made when nothing was changed', () => {
    expect(spawnInputFor(input, target, choiceOf(target))).toBeUndefined()
  })

  test('runs on the model and effort the user picked', () => {
    const choice = {
      ...choiceOf(target),
      provider: 'bedrock',
      model: 'claude-opus-4-8',
      modelIsDefault: false,
      effort: 'high' as const
    }

    expect(spawnInputFor(input, target, choice)).toEqual({
      title: 'Reviewer',
      prompt: 'review it',
      harness: 'claude',
      model: 'claude-opus-4-8',
      provider: 'bedrock',
      effort: 'high'
    })
  })

  test("leaves the model to another runtime's default when only the runtime changed", () => {
    const asked = { ...input, model: 'default' }
    const choice = { ...choiceOf(target), harness: 'pi', provider: 'openai', model: 'gpt-5' }

    expect(spawnInputFor(asked, target, choice)).toEqual({
      title: 'Reviewer',
      prompt: 'review it',
      harness: 'pi'
    })
  })
})
