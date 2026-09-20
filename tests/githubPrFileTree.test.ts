import { describe, it, expect } from 'bun:test'
import {
  buildPrFileTree,
  type PrFileTreeDirectory,
  type PrFileTreeNode
} from '../src/renderer/src/kernel/plugins/github/prFileTree'
import type { GithubPrFile } from '../src/shared/types'

function file(path: string, overrides: Partial<GithubPrFile> = {}): GithubPrFile {
  return {
    path,
    changeType: 'modified',
    added: 1,
    removed: 0,
    binary: false,
    ...overrides
  }
}

/** The tree as `name` lines, indented by depth — what a reader sees. */
function outline(nodes: PrFileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const line = `${'  '.repeat(depth)}${node.name}`
    if (node.kind === 'file') return [line]
    return [line, ...outline(node.children, depth + 1)]
  })
}

describe('buildPrFileTree', () => {
  it('nests files under the directories they live in', () => {
    const tree = buildPrFileTree([
      file('src/main/git.ts'),
      file('src/main/worktrees.ts'),
      file('README.md')
    ])

    expect(outline(tree)).toEqual(['src/main', '  git.ts', '  worktrees.ts', 'README.md'])
  })

  it('puts directories before files, each sorted by name', () => {
    const tree = buildPrFileTree([
      file('zeta.ts'),
      file('alpha.ts'),
      file('tests/b.test.ts'),
      file('scripts/a.ts')
    ])

    expect(outline(tree)).toEqual([
      'scripts',
      '  a.ts',
      'tests',
      '  b.test.ts',
      'alpha.ts',
      'zeta.ts'
    ])
  })

  // A pull request touching one deep path should cost one row, not five.
  it('folds a chain of single-child directories into one row', () => {
    const tree = buildPrFileTree([file('src/renderer/src/lib/layout.ts')])

    expect(outline(tree)).toEqual(['src/renderer/src/lib', '  layout.ts'])
    expect((tree[0] as PrFileTreeDirectory).path).toBe('src/renderer/src/lib')
  })

  it('stops folding where a directory holds more than one thing', () => {
    const tree = buildPrFileTree([file('src/main/routes/github.ts'), file('src/main/git.ts')])

    expect(outline(tree)).toEqual(['src/main', '  routes', '    github.ts', '  git.ts'])
  })

  it('carries the file through, so a row can show its counts', () => {
    const changed = file('src/util.ts', { changeType: 'added', added: 7, removed: 0 })
    const leaf = (buildPrFileTree([changed])[0] as PrFileTreeDirectory).children[0]

    expect(leaf).toMatchObject({ kind: 'file', path: 'src/util.ts', name: 'util.ts' })
    expect((leaf as { file: GithubPrFile }).file).toBe(changed)
  })

  it('keeps same-named files in different directories apart', () => {
    const tree = buildPrFileTree([file('src/index.ts'), file('sdk/index.ts')])

    expect(outline(tree)).toEqual(['sdk', '  index.ts', 'src', '  index.ts'])
  })

  it('has nothing to show for no files', () => {
    expect(buildPrFileTree([])).toEqual([])
  })
})
