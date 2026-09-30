import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { profileSocketPath } from '../src/main/socketPath'

describe('profileSocketPath', () => {
  it('keeps the socket under the profile when the path fits sun_path', () => {
    const userData = '/home/someone/.config/grove'
    const preferred = join(userData, 'sock', 'grove.sock')
    expect(profileSocketPath(userData, preferred, 'grove.sock', '/run/user/1000')).toBe(preferred)
  })

  it('moves the socket somewhere short when a deep profile would overflow sun_path', () => {
    const userData =
      '/home/someone/Documents/.worktrees/152-first-run-setup-and-onboarding-wizard/.grove-test/config/grove'
    const preferred = join(userData, 'sock', 'grove.sock')
    expect(Buffer.byteLength(preferred)).toBeGreaterThan(107)

    const path = profileSocketPath(userData, preferred, 'grove.sock', '/run/user/1000')
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
    expect(path.startsWith('/run/user/1000/grove-')).toBe(true)
    expect(path.endsWith('/grove.sock')).toBe(true)
  })

  it('gives each profile its own stable fallback directory', () => {
    const deep = '/x'.repeat(60)
    const first = profileSocketPath(`${deep}/a`, `${deep}/a/grove.sock`, 'grove.sock', '/tmp')
    const again = profileSocketPath(`${deep}/a`, `${deep}/a/grove.sock`, 'grove.sock', '/tmp')
    const other = profileSocketPath(`${deep}/b`, `${deep}/b/grove.sock`, 'grove.sock', '/tmp')
    expect(first).toBe(again)
    expect(first).not.toBe(other)
  })
})
