import { describe, it, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import {
  createFile,
  createDir,
  renamePath,
  removePath,
  listDir,
  listAll,
  readFileBytes
} from '../src/main/files'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'files-'))
}

describe('files CRUD', () => {
  it('creates a file and its parent dirs', async () => {
    const root = await tempRoot()
    await createFile(root, 'src/deep/new.ts')
    const info = await stat(join(root, 'src/deep/new.ts'))
    expect(info.isFile()).toBe(true)
  })

  it('refuses to clobber an existing file', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'exists.txt'), 'keep', 'utf8')
    await expect(createFile(root, 'exists.txt')).rejects.toThrow()
    expect(await readFile(join(root, 'exists.txt'), 'utf8')).toBe('keep')
  })

  it('creates a directory', async () => {
    const root = await tempRoot()
    await createDir(root, 'a/b/c')
    expect((await stat(join(root, 'a/b/c'))).isDirectory()).toBe(true)
  })

  it('renames across directories', async () => {
    const root = await tempRoot()
    await createFile(root, 'old.ts')
    await renamePath(root, 'old.ts', 'nested/new.ts')
    expect((await stat(join(root, 'nested/new.ts'))).isFile()).toBe(true)
    await expect(stat(join(root, 'old.ts'))).rejects.toThrow()
  })

  it('removes files and directories recursively', async () => {
    const root = await tempRoot()
    await createFile(root, 'dir/a.ts')
    await removePath(root, 'dir')
    await expect(stat(join(root, 'dir'))).rejects.toThrow()
  })

  it('rejects path-escape attempts', async () => {
    const root = await tempRoot()
    await expect(createFile(root, '../escape.ts')).rejects.toThrow('outside worktree')
    await expect(removePath(root, '../../etc/hosts')).rejects.toThrow('outside worktree')
  })

  it('refuses to remove the worktree root', async () => {
    const root = await tempRoot()
    await expect(removePath(root, '')).rejects.toThrow('worktree root')
  })

  it('lists created entries (dirs first, alphabetical)', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'zeta'))
    await createFile(root, 'alpha.ts')
    const nodes = await listDir(root, '')
    expect(nodes.map((node) => node.name)).toEqual(['zeta', 'alpha.ts'])
  })
})

describe('readFileBytes', () => {
  it('reads a binary file byte for byte', async () => {
    const root = await tempRoot()
    const bytes = new Uint8Array([0, 255, 80, 75, 3, 4])
    await writeFile(join(root, 'report.docx'), bytes)
    expect(Array.from(await readFileBytes(root, join(root, 'report.docx')))).toEqual(
      Array.from(bytes)
    )
  })

  it('refuses a path outside the worktree', async () => {
    const root = await tempRoot()
    await expect(readFileBytes(root, join(root, '..', 'elsewhere.bin'))).rejects.toThrow()
  })
})

// The file finder and "@" mentions rank every file listAll returns, so what it
// leaves out matters as much as what it finds: a gitignored dataset must not
// reach them.
describe('listAll', () => {
  /** Writes an empty file at `relativePath` under `root`, making its directories. */
  async function put(root: string, relativePath: string, content = ''): Promise<void> {
    const path = join(root, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }

  it('lists files, dotfiles included, but not what .gitignore or the app ignore', async () => {
    const root = await tempRoot()
    await simpleGit({ baseDir: root }).init()
    await put(root, '.gitignore', 'runs/\n')
    await put(root, '.env.example')
    await put(root, 'src/train.py')
    await put(root, 'runs/first/shot.jpg')
    await put(root, 'node_modules/pkg/index.js')
    await put(root, '.workbench/attachments/a.png')

    expect(await listAll(root)).toEqual(['.env.example', '.gitignore', 'src/train.py'])
  })

  it('honours .gitignore outside a git repository too', async () => {
    const root = await tempRoot()
    await put(root, '.gitignore', 'data/\n')
    await put(root, 'data/big.bin')
    await put(root, 'notes.md')

    expect(await listAll(root)).toEqual(['.gitignore', 'notes.md'])
  })

  it('stops at the limit', async () => {
    const root = await tempRoot()
    await put(root, 'a.txt')
    await put(root, 'b.txt')
    await put(root, 'c.txt')

    expect(await listAll(root, 2)).toEqual(['a.txt', 'b.txt'])
  })
})
