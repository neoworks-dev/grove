// What the Claude harness offers to pick from, and what a pick does to the
// environment the CLI runs in.
//
// The CLI only ever reports the aliases the signed-in account is entitled to —
// never Fable, never a third-party endpoint — so the catalog is what widens the
// list, and the environment is what makes a widened pick actually run.

import { describe, expect, test } from 'bun:test'
import { providerVariables, providersOf } from '../src/main/agents/harnesses/claude'
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

describe('claude harness providers', () => {
  test("keeps the CLI's own rows and adds the models it never lists", () => {
    const [anthropic] = providersOf(cliModels, catalog, noCredentials)
    expect(anthropic.provider).toBe('anthropic')
    expect(anthropic.models.map((entry) => entry.id)).toEqual([
      'default',
      'sonnet',
      'claude-fable-5-1'
    ])
    // claude-opus-5 is what `default` resolves to, so it is not listed twice.
    expect(anthropic.models[0].resolvedId).toBe('claude-opus-5')
  })

  test('offers third-party endpoints on the Anthropic wire, and not the others', () => {
    const ids = providersOf(cliModels, catalog, noCredentials).map((entry) => entry.provider)
    expect(ids).toContain('kimi-for-coding')
    expect(ids).not.toContain('deepseek')
  })

  test('keeps only the Claude models of a platform that hosts many', () => {
    const bedrock = providersOf(cliModels, catalog, noCredentials).find(
      (entry) => entry.provider === 'amazon-bedrock'
    )
    expect(bedrock?.models.map((entry) => entry.id)).toEqual(['us.anthropic.claude-opus-5'])
  })

  test('reports whether a provider has a credential yet', () => {
    const missing = providersOf(cliModels, catalog, noCredentials).find(
      (entry) => entry.provider === 'kimi-for-coding'
    )
    expect(missing?.credential).toEqual({ env: ['KIMI_API_KEY'], present: false })

    const found = providersOf(cliModels, catalog, everyCredential).find(
      (entry) => entry.provider === 'kimi-for-coding'
    )
    expect(found?.credential?.present).toBe(true)
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
