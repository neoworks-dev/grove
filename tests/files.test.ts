import { describe, it, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFile, createDir, renamePath, removePath, listDir } from '../src/main/files'

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
