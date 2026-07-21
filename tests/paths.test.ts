import { describe, it, expect } from 'bun:test'
import { relativePath } from '../src/renderer/src/lib/paths'

describe('relativePath', () => {
  it('strips the worktree base from an absolute path', () => {
    expect(relativePath('/home/user/project', '/home/user/project/src/app.ts')).toBe('src/app.ts')
  })

  it('handles a base with a trailing slash', () => {
    expect(relativePath('/home/user/project/', '/home/user/project/src/app.ts')).toBe('src/app.ts')
  })

  it('returns the path unchanged when it lies outside the base', () => {
    expect(relativePath('/home/user/project', '/etc/hosts')).toBe('/etc/hosts')
  })

  it('does not treat a sibling directory as a match', () => {
    // '/home/user/project-two' must not be relativized against '/home/user/project'.
    expect(relativePath('/home/user/project', '/home/user/project-two/a.ts')).toBe(
      '/home/user/project-two/a.ts'
    )
  })

  it('returns the absolute path when the base is empty', () => {
    expect(relativePath('', '/home/user/project/a.ts')).toBe('/home/user/project/a.ts')
  })
})
