// Picking a model, and the route a pick lands on.
//
// A session runs on one provider and one model id — one route of one model — so
// everything here is the translation between what a person picks (a model) and
// what a harness is started with (a route).

import { describe, expect, test } from 'bun:test'
import {
  decodeModelSelection,
  discoveredModelOptions,
  encodeModelSelection,
  findRoute,
  matchesQuery,
  preferredRoute,
  resolveModelSelection,
  routeDetail,
  routeReady,
  sortedRoutes
} from '../src/renderer/src/lib/agents/modelSelection'
import type { ModelEntry } from '../src/renderer/src/lib/agents/types'

const models: ModelEntry[] = [
  {
    key: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    routes: [
      { provider: 'anthropic', id: 'claude-fable-5-1', native: true },
      { provider: 'amazon-bedrock', id: 'us.anthropic.claude-fable-5-1' },
      {
        provider: 'kimi-for-coding',
        id: 'claude-fable-5-1',
        credential: { kind: 'key' as const, env: ['KIMI_API_KEY'], present: false }
      }
    ]
  },
  {
    key: 'minimax-m3',
    label: 'MiniMax-M3',
    routes: [
      {
        provider: 'minimax',
        id: 'MiniMax-M3',
        credential: { kind: 'key' as const, env: ['MINIMAX_API_KEY'], present: true }
      }
    ]
  }
]

describe('model selection', () => {
  test('round-trips open provider and model strings without delimiter assumptions', () => {
    const encoded = encodeModelSelection({ provider: 'custom:provider', model: 'family/model:v2' })
    expect(decodeModelSelection(encoded)).toEqual({
      provider: 'custom:provider',
      model: 'family/model:v2'
    })
  })

  test('finds the model behind a provider-specific id', () => {
    const found = findRoute(models, {
      provider: 'amazon-bedrock',
      model: 'us.anthropic.claude-fable-5-1'
    })
    expect(found?.entry.label).toBe('Claude Fable 5.1')
    expect(found?.route.provider).toBe('amazon-bedrock')
  })

  test('takes a route the harness blessed before one that only might work', () => {
    expect(preferredRoute(models[0])?.provider).toBe('anthropic')
  })

  test('counts a route with no credential yet as not ready', () => {
    const [native, bedrock, kimi] = models[0].routes
    expect(routeReady(native)).toBe(true)
    expect(routeReady(bedrock)).toBe(true)
    expect(routeReady(kimi)).toBe(false)
  })

  test('keeps a configured route, and falls back to the default then the first', () => {
    const configured = encodeModelSelection({ provider: 'minimax', model: 'MiniMax-M3' })
    expect(resolveModelSelection(configured, null, models)).toEqual({
      provider: 'minimax',
      model: 'MiniMax-M3'
    })

    const stale = encodeModelSelection({ provider: 'gone', model: 'gone' })
    expect(
      resolveModelSelection(stale, { provider: 'anthropic', model: 'claude-fable-5-1' }, models)
    ).toEqual({ provider: 'anthropic', model: 'claude-fable-5-1' })

    expect(resolveModelSelection(stale, { provider: 'gone', model: 'gone' }, models)).toEqual({
      provider: 'anthropic',
      model: 'claude-fable-5-1'
    })
  })

  test('flattens every route for a one-line setting', () => {
    expect(discoveredModelOptions(models).map((option) => option.label)).toEqual([
      'anthropic / Claude Fable 5.1 · claude-fable-5-1',
      'amazon-bedrock / Claude Fable 5.1 · us.anthropic.claude-fable-5-1',
      'kimi-for-coding / Claude Fable 5.1 · claude-fable-5-1',
      'minimax / MiniMax-M3 · MiniMax-M3'
    ])
  })

  test('searches names, providers and the ids a route is pasted under', () => {
    expect(matchesQuery(models[0], 'fable')).toBe(true)
    expect(matchesQuery(models[0], 'us.anthropic')).toBe(true)
    expect(matchesQuery(models[0], 'bedrock')).toBe(true)
    expect(matchesQuery(models[0], 'minimax')).toBe(false)
    expect(matchesQuery(models[0], '')).toBe(true)
  })
})

describe('endpoint list', () => {
  test('leads with the route a pick takes, then what runs, then the cheapest', () => {
    const entry: ModelEntry = {
      key: 'claude-opus-5',
      label: 'Claude Opus 5',
      routes: [
        {
          provider: 'gateway',
          id: 'anthropic/claude-opus-5',
          pricing: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
          credential: { kind: 'key', env: ['GATEWAY_KEY'], present: false }
        },
        {
          provider: 'amazon-bedrock',
          id: 'eu.anthropic.claude-opus-5',
          pricing: { input: 5.5, output: 27.5, cacheRead: 0, cacheWrite: 0 },
          credential: { kind: 'platform', env: ['AWS_PROFILE'], present: false }
        },
        {
          provider: 'amazon-bedrock',
          id: 'us.anthropic.claude-opus-5',
          pricing: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
          credential: { kind: 'platform', env: ['AWS_PROFILE'], present: false }
        },
        { provider: 'anthropic', id: 'claude-opus-5', native: true }
      ]
    }

    expect(sortedRoutes(entry).map((route) => route.id)).toEqual([
      'claude-opus-5',
      'us.anthropic.claude-opus-5',
      'eu.anthropic.claude-opus-5',
      'anthropic/claude-opus-5'
    ])
  })

  test('names the region when one seller lists a model several times', () => {
    const entry: ModelEntry = {
      key: 'claude-opus-5',
      label: 'Claude Opus 5',
      routes: [
        { provider: 'amazon-bedrock', id: 'us.anthropic.claude-opus-5-v1' },
        { provider: 'amazon-bedrock', id: 'eu.anthropic.claude-opus-5-v1' },
        { provider: 'amazon-bedrock', id: 'anthropic.claude-opus-5-v1' },
        { provider: 'anthropic', id: 'claude-opus-5' }
      ]
    }

    const detailOf = (id: string): string =>
      routeDetail(entry, entry.routes.find((route) => route.id === id)!)

    expect(detailOf('us.anthropic.claude-opus-5-v1')).toBe('us')
    expect(detailOf('eu.anthropic.claude-opus-5-v1')).toBe('eu')

    // The id the others are variations of has nothing of its own to show.
    expect(detailOf('anthropic.claude-opus-5-v1')).toBe('')

    // A seller with one endpoint for the model is already named by its row.
    expect(detailOf('claude-opus-5')).toBe('')
  })
})
