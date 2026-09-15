// Endpoints the user brings themselves.
//
// The catalog knows who sells a model; it does not know who the user has an
// account with. An OpenRouter key, a LiteLLM container or a local model behind
// a translating proxy is a base URL that speaks the Anthropic Messages API, and
// that is the whole of what Claude Code needs.

import { describe, expect, test } from 'bun:test'
import { modelIdsOf } from '../src/main/endpoints'
import { endpointVariables, modelsOf } from '../src/main/agents/harnesses/claude'
import type { CustomEndpoint } from '../src/shared/agents'

const openrouter: CustomEndpoint = {
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  keyVariable: 'GROVE_ENDPOINT_OPENROUTER',
  models: []
}

const local: CustomEndpoint = {
  id: 'local',
  label: 'LiteLLM',
  baseUrl: 'http://localhost:4000',
  models: ['kimi-k2']
}

const withKey = { lookup: () => 'sk-or-test' }
const withoutKey = { lookup: () => null }

describe('model listings from a gateway', () => {
  test("reads OpenAI's listing shape, which these gateways answer with", () => {
    expect(
      modelIdsOf({ data: [{ id: 'moonshotai/kimi-k2' }, { id: 'qwen/qwen3-coder' }] })
    ).toEqual(['moonshotai/kimi-k2', 'qwen/qwen3-coder'])
    expect(modelIdsOf([{ id: 'kimi-k2' }])).toEqual(['kimi-k2'])
  })

  test('says nothing rather than nothing-at-all when a listing is unusable', () => {
    // null leaves the user's own list alone; [] would empty it.
    expect(modelIdsOf({ error: 'nope' })).toBeNull()
    expect(modelIdsOf({ data: [] })).toBeNull()
  })
})

describe('sessions on an endpoint of your own', () => {
  test('points the CLI at the endpoint and hands it that key', () => {
    expect(endpointVariables(openrouter, withKey)).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-test',
      ANTHROPIC_API_KEY: undefined
    })
  })

  test('asks for no key when the endpoint named none, as a local one will not', () => {
    const variables = endpointVariables(local, withoutKey)
    expect(variables.ANTHROPIC_BASE_URL).toBe('http://localhost:4000')
    expect('ANTHROPIC_AUTH_TOKEN' in variables).toBe(false)
    expect(variables.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('files a gateway id under the model, so three gateways are one row', () => {
    const entries = modelsOf([], [], withoutKey, [
      { endpoint: openrouter, models: ['moonshotai/kimi-k2'] },
      { endpoint: local, models: ['kimi-k2'] }
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].routes.map((route) => route.provider)).toEqual(['openrouter', 'local'])
    expect(entries[0].routes[0].id).toBe('moonshotai/kimi-k2')
  })

  test('marks a gateway route as needing its own key, and a local one as not', () => {
    const entries = modelsOf([], [], withoutKey, [
      { endpoint: openrouter, models: ['moonshotai/kimi-k2'] },
      { endpoint: local, models: ['kimi-k2'] }
    ])
    const [gateway, offline] = entries[0].routes
    expect(gateway.credential).toEqual({
      kind: 'key',
      env: ['GROVE_ENDPOINT_OPENROUTER'],
      present: false
    })
    expect(offline.credential).toBeUndefined()
  })
})
