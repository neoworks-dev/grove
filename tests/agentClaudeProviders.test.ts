// What the Claude harness offers to pick from, and what a pick does to the
// environment the CLI runs in.
//
// The CLI only ever reports the aliases the signed-in account is entitled to —
// never Fable, never a third-party endpoint — so the catalog is what widens the
// list, and the environment is what makes a widened pick actually run.

import { describe, expect, test } from 'bun:test'
import { modelsOf, normalizeModelId, providerVariables } from '../src/main/agents/harnesses/claude'
import type { CatalogProvider } from '../src/main/modelCatalog'
import type { ModelInfo as SdkModelInfo } from '@anthropic-ai/claude-agent-sdk'

const cliModels = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Whatever the CLI recommends',
    resolvedModel: 'claude-opus-5'
  },
  { value: 'sonnet', displayName: 'Sonnet', description: '', resolvedModel: 'claude-sonnet-5' }
] as SdkModelInfo[]

const catalog: CatalogProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    sdk: '@ai-sdk/anthropic',
    api: null,
    env: ['ANTHROPIC_API_KEY'],
    models: [model('claude-opus-5', 'Claude Opus 5'), model('claude-fable-5-1', 'Claude Fable 5.1')]
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    sdk: '@ai-sdk/anthropic',
    api: 'https://api.kimi.com/coding/v1',
    env: ['KIMI_API_KEY'],
    models: [model('k3', 'K3')]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    sdk: '@ai-sdk/openai-compatible',
    api: 'https://api.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    models: [model('deepseek-v4-pro', 'DeepSeek V4 Pro')]
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    sdk: '@ai-sdk/amazon-bedrock',
    api: null,
    env: ['AWS_REGION'],
    models: [
      { ...model('us.anthropic.claude-opus-5', 'Claude Opus 5'), family: 'claude-opus' },
      { ...model('meta.llama4', 'Llama 4'), family: 'llama' }
    ]
  }
]

function model(id: string, name: string): CatalogProvider['models'][number] {
  return { id, name, family: null, contextWindow: null, maxOutput: null, pricing: null }
}

const noCredentials = { lookup: () => null }
const everyCredential = { lookup: () => 'token' }

/** The entry for one model, by the id the catalog files it under. */
function entryFor(key: string, credentials = noCredentials) {
  return modelsOf(cliModels, catalog, credentials).find((entry) => entry.key === key)
}

describe('claude harness models', () => {
  test('groups one model with every route that reaches it', () => {
    const opus = entryFor('claude-opus-5')
    expect(opus?.routes.map((route) => route.provider)).toEqual(['anthropic', 'amazon-bedrock'])
    expect(opus?.routes[1].id).toBe('us.anthropic.claude-opus-5')
  })

  test("files the account's alias under the model it resolves to, and keeps its name", () => {
    const opus = entryFor('claude-opus-5')
    const anthropic = opus?.routes.find((route) => route.provider === 'anthropic')
    expect(anthropic?.id).toBe('default')
    expect(anthropic?.label).toBe('Default (recommended)')
    expect(anthropic?.native).toBe(true)
    // One route per provider: the blessed alias, not the alias and the wire id.
    expect(opus?.routes.filter((route) => route.provider === 'anthropic')).toHaveLength(1)
  })

  test('lists a model the CLI never offers, which is the whole point', () => {
    expect(entryFor('claude-fable-5-1')?.label).toBe('Claude Fable 5.1')
  })

  test('offers third-party endpoints on the Anthropic wire, and not the others', () => {
    const providers = modelsOf(cliModels, catalog, noCredentials).flatMap((entry) =>
      entry.routes.map((route) => route.provider)
    )
    expect(providers).toContain('kimi-for-coding')
    expect(providers).not.toContain('deepseek')
  })

  test('keeps only the Claude models of a platform that hosts many', () => {
    const bedrockIds = modelsOf(cliModels, catalog, noCredentials).flatMap((entry) =>
      entry.routes.filter((route) => route.provider === 'amazon-bedrock').map((route) => route.id)
    )
    expect(bedrockIds).toEqual(['us.anthropic.claude-opus-5'])
  })

  test('reports whether a route has a key yet', () => {
    const missing = entryFor('k3')?.routes[0]
    expect(missing?.credential).toEqual({ kind: 'key', env: ['KIMI_API_KEY'], present: false })
    expect(entryFor('k3', everyCredential)?.routes[0].credential?.present).toBe(true)
  })

  test("asks for nothing on Anthropic's own endpoint, which the CLI signs into", () => {
    const anthropic = entryFor('claude-opus-5')?.routes.find(
      (route) => route.provider === 'anthropic'
    )
    expect(anthropic?.credential).toBeUndefined()
  })

  test('calls a cloud platform a sign-in rather than a key to paste', () => {
    const bedrock = entryFor('claude-opus-5')?.routes.find(
      (route) => route.provider === 'amazon-bedrock'
    )
    expect(bedrock?.credential?.kind).toBe('platform')
  })

  test('reads a regional platform listing as the model it is', () => {
    // Bedrock lists this per region; without normalising the region away it is
    // a separate model in the picker, named after the region.
    expect(normalizeModelId('au.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
  })

  test('puts what the account can run first', () => {
    const entries = modelsOf(cliModels, catalog, noCredentials)
    expect(entries[0].routes.some((route) => route.native)).toBe(true)
  })
})

describe('model ids across platforms', () => {
  test('reads a platform spelling as the model behind it', () => {
    expect(normalizeModelId('us.anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(normalizeModelId('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5'
    )
    expect(normalizeModelId('claude-fable-5@default')).toBe('claude-fable-5')
  })

  test('keeps a variant that is genuinely a different model to run', () => {
    expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
  })

  test('folds a dated snapshot into the moving id that points at it', () => {
    // The catalog lists both, as "Claude Haiku 4.5 (latest)" and "Claude Haiku
    // 4.5"; they are one model, and two rows for it is what made the list long.
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe(normalizeModelId('claude-haiku-4-5'))
  })
})

describe('claude session environment', () => {
  test('points the CLI at a third-party endpoint with that provider key', () => {
    const kimi = catalog[1]
    expect(providerVariables(kimi, everyCredential)).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/v1',
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_API_KEY: undefined
    })
  })

  test("drops grove's Anthropic key so it never reaches another endpoint", () => {
    const variables = providerVariables(catalog[1], noCredentials)
    expect(variables.ANTHROPIC_API_KEY).toBeUndefined()
    expect('ANTHROPIC_API_KEY' in variables).toBe(true)
    expect(variables.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('uses the platform flag for Bedrock rather than a base URL', () => {
    expect(providerVariables(catalog[3], everyCredential)).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1' })
  })
})
