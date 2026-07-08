import { describe, it, expect } from 'bun:test'
import { applyDefaults } from '../src/main/config'
import { load } from 'js-yaml'

describe('applyDefaults', () => {
  it('fills all fields from an empty object', () => {
    const config = applyDefaults({})
    expect(config.workbench.worktrees_dir).toBe('../.worktrees')
    expect(config.workbench.default_base_branch).toBe('main')
    expect(config.ports.start).toBe(3100)
    expect(config.ports.count_per_worktree).toBe(10)
    expect(config.setup.once).toEqual([])
    expect(config.services).toEqual({})
    expect(config.agents).toEqual({})
  })

  it('preserves provided values and defaults the rest', () => {
    const parsed = load(`
ports:
  start: 4000
services:
  web:
    command: bun dev --port \${PORT_0}
    preview: http://localhost:\${PORT_0}
agents:
  claude:
    command: claude -p
`)
    const config = applyDefaults(parsed)
    expect(config.ports.start).toBe(4000)
    expect(config.ports.count_per_worktree).toBe(10) // defaulted
    expect(config.services.web.command).toBe('bun dev --port ${PORT_0}')
    expect(config.agents.claude.command).toBe('claude -p')
    expect(config.workbench.default_base_branch).toBe('main')
  })
})
