// Finding a place an agent pointed at after the code has moved under it.
//
// The agent names lines; by the time the user clicks, an edit above them, a
// reformat, or a rename may have put other code there. The place is found again
// by the text it held, and the row says so when that text is gone.

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorLocations,
  anchorText,
  relocate,
  resolveLocations
} from '../src/main/agents/locationAnchor'
import type { CodeLocation } from '../src/shared/agents'

const SOURCE = [
  'import { db } from "./db"',
  '',
  'export function load(id) {',
  '  const row = db.get(id)',
  '  return row',
  '}',
  '',
  'export function save(row) {',
  '  db.put(row)',
  '}'
].join('\n')

/** A location on `save`, taken down against SOURCE. */
function pointAtSave(): CodeLocation {
  return {
    path: 'src/store.ts',
    startLine: 8,
    endLine: 10,
    note: 'Writes a row.',
    annotations: [{ line: 9, text: 'No transaction.' }],
    anchor: { text: anchorText(SOURCE, 8, 10)! }
  }
}

describe('finding the lines again', () => {
  test('lines that still read the same stay where they are', () => {
    expect(relocate(pointAtSave(), SOURCE).state).toBe('current')
  })

  test('lines pushed down by an edit above are followed, notes and all', () => {
    const edited = SOURCE.replace(
      'export function load',
      '// Loads a row.\n// Or null.\nexport function load'
    )

    const found = relocate(pointAtSave(), edited)

    expect(found.state).toBe('moved')
    expect(found.location).toMatchObject({
      startLine: 10,
      endLine: 12,
      annotations: [{ line: 11, text: 'No transaction.' }]
    })
  })

  test('reformatted lines are found by their text, whitespace aside', () => {
    const edited = `\n${SOURCE.replace('  db.put(row)', '    db.put( row )')}`

    const found = relocate(pointAtSave(), edited)

    expect(found.state).toBe('moved')
    expect(found.location.startLine).toBe(9)
  })

  test('code that repeats resolves to the copy whose surroundings match', () => {
    const text = 'a\nx = 1\nb\nc\nx = 1\nd'
    const location: CodeLocation = {
      path: 'f',
      startLine: 5,
      endLine: 5,
      anchor: { text: anchorText(text, 5, 5)! }
    }
    // Two lines added at the top: the second copy is now line 7, the first line 4.
    const found = relocate(location, `new\nnew\n${text}`)

    expect(found.location.startLine).toBe(7)
  })

  test('lines rewritten since are reported as changed, not marked somewhere else', () => {
    const edited = SOURCE.replace('  db.put(row)', '  db.upsert(row, { replace: true })')

    const found = relocate(pointAtSave(), edited)

    expect(found.state).toBe('changed')
    expect(found.location.startLine).toBe(8)
  })

  test('changed lines still open where their first line went', () => {
    const edited = `// header\n${SOURCE.replace('  db.put(row)', '  db.upsert(row)')}`

    const found = relocate(pointAtSave(), edited)

    expect(found.state).toBe('changed')
    expect(found.location.startLine).toBe(9)
  })

  test('a location without its text is taken as it is', () => {
    expect(relocate({ path: 'f', startLine: 3 }, 'x').state).toBe('current')
  })
})

// ── Against a real worktree ─────────────────────────────────────

let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

/** A git repository holding SOURCE at src/store.ts, committed. */
async function repository(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'grove-anchor-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root!, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/store.ts'), SOURCE)
  git('add', '.')
  git('commit', '-q', '-m', 'start')
  return root
}

/** The agent pointing at `save`, taken down the way show_locations does. */
async function pointedAtSave(worktree: string): Promise<CodeLocation> {
  const [location] = await anchorLocations(worktree, [
    { path: 'src/store.ts', startLine: 8, endLine: 10 }
  ])
  return location
}

describe('resolving in a worktree', () => {
  test('pointing takes down the lines and the commit', async () => {
    const worktree = await repository()

    const location = await pointedAtSave(worktree)

    expect(location.anchor?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(location.anchor?.text?.lines).toEqual([
      'export function save(row) {',
      '  db.put(row)',
      '}'
    ])
  })

  test('a file renamed with git is followed to its new name', async () => {
    const worktree = await repository()
    const location = await pointedAtSave(worktree)
    execFileSync('git', ['mv', 'src/store.ts', 'src/rows.ts'], { cwd: worktree })

    const [found] = await resolveLocations(worktree, [location])

    expect(found.state).toBe('moved')
    expect(found.location.path).toBe(join(worktree, 'src/rows.ts'))
    expect(found.location.startLine).toBe(8)
  })

  test('a file moved without git is found by its text', async () => {
    const worktree = await repository()
    const location = await pointedAtSave(worktree)
    await mkdir(join(worktree, 'lib'))
    await rename(join(worktree, 'src/store.ts'), join(worktree, 'lib/persistence.ts'))

    const [found] = await resolveLocations(worktree, [location])

    expect(found.state).toBe('moved')
    expect(found.location.path).toBe(join(worktree, 'lib/persistence.ts'))
  })

  test('a file renamed and rewritten, past what git calls a rename, is found by its first line', async () => {
    const worktree = await repository()
    const location = await pointedAtSave(worktree)
    execFileSync('git', ['mv', 'src/store.ts', 'src/rows.ts'], { cwd: worktree })
    const rewritten = 'export function save(row) {\n  return db.transaction(() => db.put(row))\n}\n'
    await writeFile(join(worktree, 'src/rows.ts'), rewritten)

    const [found] = await resolveLocations(worktree, [location])

    expect(found.state).toBe('changed')
    expect(found.location.path).toBe(join(worktree, 'src/rows.ts'))
    expect(found.location.startLine).toBe(1)
  })

  test('a deleted file is reported as removed', async () => {
    const worktree = await repository()
    const location = await pointedAtSave(worktree)
    await unlink(join(worktree, 'src/store.ts'))

    const [found] = await resolveLocations(worktree, [location])

    expect(found.state).toBe('removed')
  })

  test('a path outside the worktree is left alone', async () => {
    const worktree = await repository()

    const [found] = await resolveLocations(worktree, [{ path: '/etc/hostname', startLine: 1 }])

    expect(found.state).toBe('current')
  })
})
