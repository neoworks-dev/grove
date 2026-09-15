// The public catalog, as grove reads it.
//
// models.dev keys providers and models by id and grows fields over time, so the
// parser has to survive entries it does not recognise and drop the ones it
// cannot use at all.

import { describe, expect, test } from 'bun:test'
import { parseCatalog, providersUsing } from '../src/main/modelCatalog'

const payload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-fable-5-1': {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        family: 'claude-fable',
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 }
      }
    }
  },
  'kimi-for-coding': {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.kimi.com/coding/v1',
    env: ['KIMI_API_KEY'],
    models: { k3: { id: 'k3', name: 'K3' } }
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    npm: '@ai-sdk/openai-compatible',
    env: ['DEEPSEEK_API_KEY'],
    models: {}
  },
  broken: { name: 'No client named' }
}

describe('model catalog', () => {
  test('reads providers, endpoints, credentials and model limits', () => {
    const providers = parseCatalog(payload)
    const anthropic = providers.find((provider) => provider.id === 'anthropic')
    expect(anthropic?.sdk).toBe('@ai-sdk/anthropic')
    expect(anthropic?.api).toBeNull()
    expect(anthropic?.env).toEqual(['ANTHROPIC_API_KEY'])

    const fable = anthropic?.models[0]
    expect(fable?.id).toBe('claude-fable-5-1')
    expect(fable?.name).toBe('Claude Fable 5.1')
    expect(fable?.contextWindow).toBe(1_000_000)
    expect(fable?.pricing).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 })

    const kimi = providers.find((provider) => provider.id === 'kimi-for-coding')
    expect(kimi?.api).toBe('https://api.kimi.com/coding/v1')
  })

  test('drops an entry with no client to identify its wire protocol', () => {
    expect(parseCatalog(payload).some((provider) => provider.id === 'broken')).toBe(false)
  })

  test('survives a payload that is not a catalog at all', () => {
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog(['anthropic'])).toEqual([])
  })

  test('selects providers by the client they speak', () => {
    const anthropicWire = providersUsing(parseCatalog(payload), ['@ai-sdk/anthropic'])
    expect(anthropicWire.map((provider) => provider.id)).toEqual(['anthropic', 'kimi-for-coding'])
  })

  test('leaves a model with no price or limit unpriced rather than guessing', () => {
    const providers = parseCatalog(payload)
    const k3 = providers.find((provider) => provider.id === 'kimi-for-coding')?.models[0]
    expect(k3?.pricing).toBeNull()
    expect(k3?.contextWindow).toBeNull()
  })
})
