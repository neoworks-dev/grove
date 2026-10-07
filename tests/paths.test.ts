import { describe, it, expect } from 'bun:test'
import { relativeInside, relativePath } from '../src/renderer/src/lib/paths'

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

describe('relativeInside', () => {
  it('relativizes an absolute path inside the worktree', () => {
    expect(relativeInside('/repo', '/repo/src/app.ts')).toBe('src/app.ts')
  })

  it('takes a relative path against the worktree', () => {
    expect(relativeInside('/repo', 'src/./app.ts')).toBe('src/app.ts')
  })

  it('returns null for a relative path that climbs out', () => {
    expect(relativeInside('/repo', '../other/a.ts')).toBeNull()
  })

  it('returns null for an absolute path that climbs out through the root', () => {
    expect(relativeInside('/repo', '/repo/../other/a.ts')).toBeNull()
  })

  it('returns null for a path elsewhere on disk or in a sibling directory', () => {
    expect(relativeInside('/repo', '/etc/hosts')).toBeNull()
    expect(relativeInside('/repo', '/repo-two/a.ts')).toBeNull()
  })

  it('keeps a `..` that stays inside the worktree', () => {
    expect(relativeInside('/repo/', '/repo/src/../lib/a.ts')).toBe('lib/a.ts')
  })

  it('returns an empty path for the root itself', () => {
    expect(relativeInside('/repo', '/repo/')).toBe('')
  })
})
