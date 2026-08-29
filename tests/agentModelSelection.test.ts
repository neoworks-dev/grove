import { describe, expect, test } from 'bun:test'
import {
  decodeModelSelection,
  discoveredModelOptions,
  encodeModelSelection,
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
