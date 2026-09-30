// Paths an agent names in its answer, found so they can become links.
//
// Finding is deliberately generous — whether a file exists is checked before
// anything becomes a link — but it must not reach into URLs or the middle of
// other words, and must read the line a reference points at.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existingFiles } from '../src/main/files'
import {
  findCodeReferences,
  parseCodeReference,
  worktreePathOf
} from '../src/renderer/src/lib/agents/codeReferences'

describe('which named paths are files', () => {
  test('only files inside the worktree count', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'grove-refs-'))
    const root = join(parent, 'repo')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), '')
    await writeFile(join(parent, 'outside.ts'), '')

    const found = await existingFiles(root, [
      'src/a.ts',
      'src',
      'src/missing.ts',
      '../outside.ts',
      '/etc/hosts'
    ])

    expect(found).toEqual(['src/a.ts'])
    await rm(parent, { recursive: true, force: true })
  })
})

describe('inline code', () => {
  test('a path alone is a reference', () => {
    expect(parseCodeReference('src/auth.ts')).toEqual({ path: 'src/auth.ts' })
    expect(parseCodeReference('Makefile')).toEqual({ path: 'Makefile' })
  })

  test('reads a line, a range, a column and GitHub anchors', () => {
    expect(parseCodeReference('src/auth.ts:42')).toEqual({
      path: 'src/auth.ts',
      line: 42,
      endLine: 42
    })
    expect(parseCodeReference('src/auth.ts:42-48')).toEqual({
      path: 'src/auth.ts',
      line: 42,
      endLine: 48
    })
    expect(parseCodeReference('src/auth.ts:42:7')).toEqual({
      path: 'src/auth.ts',
      line: 42,
      endLine: 42
    })
    expect(parseCodeReference('src/auth.ts#L3-L9')).toEqual({
      path: 'src/auth.ts',
      line: 3,
      endLine: 9
    })
  })

  test('a range running backwards is its first line', () => {
    expect(parseCodeReference('a.ts:9-3')).toEqual({ path: 'a.ts', line: 9, endLine: 9 })
  })

  test('code that is more than a path is not a reference', () => {
    expect(parseCodeReference('greet("grove")')).toBeNull()
    expect(parseCodeReference('bun run test')).toBeNull()
    expect(parseCodeReference('a.ts:x')).toBeNull()
  })
})

describe('prose', () => {
  test('finds paths with their positions and lines', () => {
    const text = 'The check is in src/auth.ts:42, called from lib/session.ts.'
    expect(findCodeReferences(text)).toEqual([
      { path: 'src/auth.ts', line: 42, endLine: 42, index: 16, length: 14 },
      { path: 'lib/session.ts', index: 44, length: 14 }
    ])
  })

  test('needs an extension, so plain words are left alone', () => {
    expect(findCodeReferences('Run the tests and then build')).toEqual([])
    expect(findCodeReferences('see README.md')).toEqual([
      { path: 'README.md', index: 4, length: 9 }
    ])
  })

  test('does not reach into a URL', () => {
    expect(findCodeReferences('https://github.com/org/repo/blob/main/src/a.ts')).toEqual([])
  })
})

describe('worktree paths', () => {
  test('relative paths are kept, less a leading ./', () => {
    expect(worktreePathOf('./src/a.ts', '/repo')).toBe('src/a.ts')
    expect(worktreePathOf('src/a.ts', '/repo')).toBe('src/a.ts')
  })

  test('absolute paths inside the worktree become relative', () => {
    expect(worktreePathOf('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  })

  test('anything outside the worktree is refused', () => {
    expect(worktreePathOf('/etc/passwd', '/repo')).toBeNull()
    expect(worktreePathOf('/repository/a.ts', '/repo')).toBeNull()
    expect(worktreePathOf('../other/a.ts', '/repo')).toBeNull()
  })
})
