import { describe, it, expect } from 'bun:test'
import { parseWorktreePorcelain, parseNameStatusZ, detectLanguage } from '../src/main/git'

describe('parseWorktreePorcelain', () => {
  it('parses multiple worktree blocks', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123def456',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/feature',
      'HEAD 111222333444',
      'branch refs/heads/feature-x',
      '',
      'worktree /repo/.worktrees/detached',
      'HEAD 999888777666',
      'detached',
      ''
    ].join('\n')

    const result = parseWorktreePorcelain(output)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ path: '/repo', branch: 'main', isDetached: false })
    expect(result[1].branch).toBe('feature-x')
    expect(result[2].isDetached).toBe(true)
    expect(result[2].branch).toBe('')
  })

  it('flags bare and locked worktrees', () => {
    const output = ['worktree /repo/bare', 'bare', '', 'worktree /repo/wt', 'HEAD aa', 'branch refs/heads/x', 'locked', ''].join('\n')
    const result = parseWorktreePorcelain(output)
    expect(result[0].isBare).toBe(true)
    expect(result[1].locked).toBe(true)
  })
})

describe('parseNameStatusZ', () => {
  it('parses modifications and additions', () => {
    const output = 'M\0src/a.ts\0A\0src/b.ts\0'
    const files = parseNameStatusZ(output, false)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'src/a.ts', changeType: 'modified', staged: false })
    expect(files[1]).toMatchObject({ path: 'src/b.ts', changeType: 'added' })
  })

  it('parses renames consuming two path fields', () => {
    const output = 'R100\0old/name.ts\0new/name.ts\0M\0other.ts\0'
    const files = parseNameStatusZ(output, true)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({
      path: 'new/name.ts',
      oldPath: 'old/name.ts',
      changeType: 'renamed',
      staged: true
    })
    expect(files[1].path).toBe('other.ts')
  })

  it('returns empty for empty output', () => {
    expect(parseNameStatusZ('', false)).toEqual([])
  })
})

describe('detectLanguage', () => {
  it('maps common extensions', () => {
    expect(detectLanguage('a/b.ts')).toBe('typescript')
    expect(detectLanguage('x.json')).toBe('json')
    expect(detectLanguage('y.unknownext')).toBe('plaintext')
  })
})
