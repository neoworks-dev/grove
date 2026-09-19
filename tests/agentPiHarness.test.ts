// What the pi harness reads out of pi itself.
//
// Both of these used to be lists written into grove: the tools pi brings and the
// policy each one gets. Asking pi instead means a tool pi adds is gated rather
// than silently running unprompted, so the derivation is pinned here — a pi
// upgrade that moves a tool between the two sets fails this rather than the app.

import { describe, expect, test } from 'bun:test'
import { builtinPolicies, commandLine } from '../src/main/agents/harnesses/pi'

describe('builtinPolicies', () => {
  test('reading answers a question, so it runs without a prompt', async () => {
    const policies = await builtinPolicies()
    expect(policies.get('read')).toBe('allow')
    expect(policies.get('grep')).toBe('allow')
    expect(policies.get('find')).toBe('allow')
    expect(policies.get('ls')).toBe('allow')
  })

  test('anything that changes something is held for a decision', async () => {
    const policies = await builtinPolicies()
    expect(policies.get('edit')).toBe('ask')
    expect(policies.get('write')).toBe('ask')
    expect(policies.get('bash')).toBe('ask')
  })

  test('every tool pi brings has a policy', async () => {
    const { createCodingTools, createReadOnlyTools } =
      await import('@earendil-works/pi-coding-agent')
    const tools = [...createCodingTools(process.cwd()), ...createReadOnlyTools(process.cwd())]
    const policies = await builtinPolicies()
    for (const tool of tools) expect(policies.has(tool.name)).toBe(true)
  })
})

describe('commandLine', () => {
  test('a command with no arguments is the name alone', () => {
    expect(commandLine('compact', '')).toBe('/compact')
    expect(commandLine('compact', '   ')).toBe('/compact')
  })

  test('arguments follow the name', () => {
    expect(commandLine('skill:review', ' the diff ')).toBe('/skill:review the diff')
  })
})
