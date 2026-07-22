import { describe, it, expect } from 'bun:test'
import {
  PLUGIN_PERMISSIONS,
  PERMISSION_META,
  validateManifest
} from '../sdk/src/protocol'

describe('PERMISSION_META', () => {
  it('covers every permission exactly', () => {
    expect(Object.keys(PERMISSION_META).sort()).toEqual([...PLUGIN_PERMISSIONS].sort())
  })

  it('every entry has non-empty copy and a valid risk tier', () => {
    for (const meta of Object.values(PERMISSION_META)) {
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
      expect(['read', 'write', 'danger']).toContain(meta.risk)
    }
  })

  it('reserved scopes are marked danger', () => {
    expect(PERMISSION_META.shell.reserved).toBe(true)
    expect(PERMISSION_META.net.reserved).toBe(true)
    expect(PERMISSION_META.shell.risk).toBe('danger')
    expect(PERMISSION_META.net.risk).toBe('danger')
  })
})

describe('manifest validation with new scopes', () => {
  const base = {
    id: 'test.plugin',
    name: 'Test',
    version: '1.0.0',
    entry: 'dist/extension.js'
  }

  it('accepts every new domain scope', () => {
    const result = validateManifest({
      ...base,
      permissions: [
        'editor.read',
        'editor.edit',
        'git.read',
        'git.write',
        'worktrees.manage',
        'agents.read',
        'agents.run',
        'terminal.exec',
        'languages.read',
        'services.read',
        'services.manage'
      ]
    })
    expect(result.ok).toBe(true)
  })

  it('still rejects unknown scopes', () => {
    const result = validateManifest({ ...base, permissions: ['git.everything'] })
    expect(result.ok).toBe(false)
  })
})
