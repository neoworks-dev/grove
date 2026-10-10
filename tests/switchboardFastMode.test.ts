import { describe, expect, test } from 'bun:test'
import { reportedFastMode, requestFastMode } from '../src/main/agents/switchboard/fastMode'
import { parseSession } from '../src/main/agents/store'

describe('requestFastMode', () => {
  test('sets the fast option to on and off', async () => {
    const sent: [string, string][] = []
    const session = {
      configOptions: [{ id: 'model' }, { id: 'fast' }],
      setConfigOption: async (configId: string, value: string): Promise<void> => {
        sent.push([configId, value])
      }
    }
    await requestFastMode(session, true)
    await requestFastMode(session, false)
    expect(sent).toEqual([
      ['fast', 'on'],
      ['fast', 'off']
    ])
  })

  test('refuses, saying why, when the model offers no fast mode', async () => {
    const session = {
      configOptions: [{ id: 'model' }],
      setConfigOption: async (): Promise<void> => {}
    }
    await expect(requestFastMode(session, true)).rejects.toThrow('does not offer it')
  })

  test('refuses when the harness cannot change options at all', async () => {
    await expect(requestFastMode({ configOptions: [{ id: 'fast' }] }, true)).rejects.toThrow(
      'cannot change it'
    )
  })
})

describe('stored sessions', () => {
  test('one saved before fast mode existed reads back with it off', () => {
    const stored = JSON.stringify({ id: 'a', harness: 'claude', provider: '', model: '' })
    expect(parseSession(stored).fastMode).toBe(false)
  })

  test('fast mode survives being stored', () => {
    const stored = JSON.stringify({ id: 'a', harness: 'claude', fastMode: true })
    expect(parseSession(stored).fastMode).toBe(true)
  })
})

describe('reportedFastMode', () => {
  test('reads on and off from the harness option, in either spelling', () => {
    expect(reportedFastMode([{ id: 'fast', currentValue: 'on' }])).toBe(true)
    expect(reportedFastMode([{ id: 'fast', currentValue: 'off' }])).toBe(false)
    expect(reportedFastMode([{ id: 'fast', currentValue: true }])).toBe(true)
    expect(reportedFastMode([{ id: 'fast', currentValue: false }])).toBe(false)
  })

  test('says nothing when the harness lists no fast option', () => {
    expect(reportedFastMode([{ id: 'model', currentValue: 'x' }])).toBeNull()
  })
})
