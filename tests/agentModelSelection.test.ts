import { describe, expect, test } from 'bun:test'
import {
  decodeModelSelection,
  describeModel,
  discoveredModelOptions,
  encodeModelSelection,
  modelName,
  modelWireId,
  resolveModelSelection
} from '../src/renderer/src/lib/agents/modelSelection'
import type { ProviderModels } from '../src/renderer/src/lib/agents/types'

const providers: ProviderModels[] = [
  {
    provider: 'anthropic',
    models: [
      { provider: 'anthropic', id: 'claude-fast' },
      { provider: 'anthropic', id: 'claude:deep' }
    ]
  },
  { provider: 'openai', models: [{ provider: 'openai', id: 'gpt-code' }] }
]

describe('task model selection', () => {
  test('round-trips open provider and model strings without delimiter assumptions', () => {
    const encoded = encodeModelSelection({ provider: 'custom:provider', model: 'family/model:v2' })
    expect(decodeModelSelection(encoded)).toEqual({
      provider: 'custom:provider',
      model: 'family/model:v2'
    })
  })

  test('flattens provider-discovered models for a selector', () => {
    expect(discoveredModelOptions(providers).map((option) => option.label)).toEqual([
      'anthropic / claude-fast',
      'anthropic / claude:deep',
      'openai / gpt-code'
    ])
  })

  test('names an alias row by what it resolves to, not by the alias', () => {
    const alias = {
      provider: 'anthropic',
      id: 'default',
      label: 'Default (recommended)',
      resolvedId: 'claude-opus-5'
    }
    expect(modelName(alias)).toBe('Default (recommended)')
    expect(modelWireId(alias)).toBe('claude-opus-5')
    expect(describeModel(alias)).toBe('Default (recommended) · claude-opus-5')
  })

  test('says a bare id once, with no label and nothing to resolve', () => {
    const bare = { provider: 'openai', id: 'gpt-code' }
    expect(modelName(bare)).toBe('gpt-code')
    expect(modelWireId(bare)).toBe('gpt-code')
    expect(describeModel(bare)).toBe('gpt-code')
  })

  test('carries the resolved id into selector labels', () => {
    const aliased = [
      {
        provider: 'anthropic',
        models: [
          {
            provider: 'anthropic',
            id: 'opus[1m]',
            label: 'Opus (1M context)',
            resolvedId: 'claude-opus-5[1m]'
          }
        ]
      }
    ]
    expect(discoveredModelOptions(aliased).map((option) => option.label)).toEqual([
      'anthropic / Opus (1M context) · claude-opus-5[1m]'
    ])
  })

  test('uses a valid configured model independently of the server default', () => {
    const configured = encodeModelSelection({ provider: 'openai', model: 'gpt-code' })
    expect(
      resolveModelSelection(configured, { provider: 'anthropic', model: 'claude-fast' }, providers)
    ).toEqual({ provider: 'openai', model: 'gpt-code' })
  })

  test('falls back from a stale setting to the discovered default, then first model', () => {
    expect(
      resolveModelSelection('stale', { provider: 'anthropic', model: 'claude:deep' }, providers)
    ).toEqual({ provider: 'anthropic', model: 'claude:deep' })
    expect(resolveModelSelection('stale', { provider: 'gone', model: 'gone' }, providers)).toEqual({
      provider: 'anthropic',
      model: 'claude-fast'
    })
  })
})
