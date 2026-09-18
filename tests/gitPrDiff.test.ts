import { describe, expect, test } from 'bun:test'
import { parseNameStatusZ, parseNumstat, zipFilesWithStats } from '../src/main/git'

describe('zipFilesWithStats', () => {
  test('pairs each file with the counts in the same position', () => {
    const files = parseNameStatusZ('M\0src/a.ts\0A\0src/b.ts\0', false)
    const stats = parseNumstat('3\t1\tsrc/a.ts\n40\t0\tsrc/b.ts\n')
    expect(zipFilesWithStats(files, stats)).toEqual([
      { path: 'src/a.ts', changeType: 'modified', added: 3, removed: 1, binary: false },
      { path: 'src/b.ts', changeType: 'added', added: 40, removed: 0, binary: false }
    ])
  })

  test('keeps the path a rename came from', () => {
    const files = parseNameStatusZ('R100\0src/old.ts\0src/new.ts\0', false)
    const stats = parseNumstat('0\t0\tsrc/{old => new}.ts\n')
    expect(zipFilesWithStats(files, stats)).toEqual([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        changeType: 'renamed',
        added: 0,
        removed: 0,
        binary: false
      }
    ])
  })

  test('a file numstat reports as - is binary, with no counts', () => {
    const files = parseNameStatusZ('M\0resources/icon.png\0', false)
    const stats = parseNumstat('-\t-\tresources/icon.png\n')
    expect(zipFilesWithStats(files, stats)).toEqual([
      { path: 'resources/icon.png', changeType: 'modified', added: 0, removed: 0, binary: true }
    ])
  })

  test('a file with no stat line at all is binary rather than NaN', () => {
    const files = parseNameStatusZ('M\0src/a.ts\0', false)
    expect(zipFilesWithStats(files, [])).toEqual([
      { path: 'src/a.ts', changeType: 'modified', added: 0, removed: 0, binary: true }
    ])
  })
})
