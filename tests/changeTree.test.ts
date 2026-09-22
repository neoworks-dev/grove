// The changes view's rows: a compacted folder tree or a flat list, with
// collapsed folders hiding what is under them.

import { describe, expect, test } from 'bun:test'
import {
  changeRows,
  type ChangeRow
} from '../src/renderer/src/kernel/plugins/gitChanges/changeTree'
import type { DiffFile } from '../src/shared/types'

/** A modified, unstaged file at a path. */
function file(path: string): DiffFile {
  return { path, changeType: 'modified', staged: false }
}

/** A row as `depth name`, so a layout reads as an indented outline. */
function outline(rows: ChangeRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'folder') return `${row.depth} ${row.name}/`
    return `${row.depth} ${row.file.path}`
  })
}

const FILES = [
  file('src/main/git.ts'),
  file('src/main/routes/git.ts'),
  file('README.md'),
  file('src/renderer/src/kernel/plugins/gitChanges/index.ts'),
  file('package.json')
]

describe('changeRows', () => {
  test('list layout is every file by path, flat', () => {
    expect(outline(changeRows(FILES, 'list', new Set()))).toEqual([
      '0 package.json',
      '0 README.md',
      '0 src/main/git.ts',
      '0 src/main/routes/git.ts',
      '0 src/renderer/src/kernel/plugins/gitChanges/index.ts'
    ])
  })

  test('tree layout joins lone-child folders and puts folders before files', () => {
    expect(outline(changeRows(FILES, 'tree', new Set()))).toEqual([
      '0 src/',
      '1 main/',
      '2 routes/',
      '3 src/main/routes/git.ts',
      '2 src/main/git.ts',
      '1 renderer/src/kernel/plugins/gitChanges/',
      '2 src/renderer/src/kernel/plugins/gitChanges/index.ts',
      '0 package.json',
      '0 README.md'
    ])
  })

  test('a joined folder is keyed by its deepest path', () => {
    const rows = changeRows(FILES, 'tree', new Set())
    const joined = rows.find((row) => row.kind === 'folder' && row.name.startsWith('renderer'))
    expect(joined).toMatchObject({
      path: 'src/renderer/src/kernel/plugins/gitChanges',
      fileCount: 1
    })
  })

  test('a collapsed folder keeps its row and hides its contents', () => {
    expect(outline(changeRows(FILES, 'tree', new Set(['src/main'])))).toEqual([
      '0 src/',
      '1 main/',
      '1 renderer/src/kernel/plugins/gitChanges/',
      '2 src/renderer/src/kernel/plugins/gitChanges/index.ts',
      '0 package.json',
      '0 README.md'
    ])
  })

  test('a single folder chain at the root collapses to one row', () => {
    expect(outline(changeRows([file('a/b/c/d.ts')], 'tree', new Set()))).toEqual([
      '0 a/b/c/',
      '1 a/b/c/d.ts'
    ])
  })
})
