import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import { VersionCounter, isStale } from '../src/main/api/versions'
import { RouteRegistry } from '../src/main/api/registry'
import { ApiDispatcher } from '../src/main/api/dispatcher'
import { registerGitRoutes, type GitRouteDeps } from '../src/main/api/routes/git'
import { EventHub } from '../src/main/api/events'
import type { ClientRecord } from '../src/main/api/clients'
import type { PermissionBroker } from '../src/main/api/broker'
import type { CheckpointManager } from '../src/main/checkpoints'
import type { Worktree } from '../src/shared/types'

describe('VersionCounter + isStale', () => {
  it('starts at 1 and bumps per key', () => {
    const versions = new VersionCounter()
    expect(versions.current('a')).toBe(1)
    expect(versions.bump('a')).toBe(2)
    expect(versions.current('a')).toBe(2)
    expect(versions.current('b')).toBe(1)
  })

  it('isStale only when an expected version was supplied and moved', () => {
    expect(isStale(3, undefined)).toBe(false)
    expect(isStale(3, 3)).toBe(false)
    expect(isStale(3, 2)).toBe(true)
  })
})

describe('git routes optimistic concurrency', () => {
  let root: string
  let worktree: Worktree
  let versions: VersionCounter
  let dispatcher: ApiDispatcher

  const client: ClientRecord = {
    key: 'plugin:test.plugin',
    kind: 'plugin',
    id: 'test.plugin',
    name: 'Test',
    source: 'user',
    declaredScopes: ['git.read', 'git.write']
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'grove-gitroutes-'))
    const git = simpleGit({ baseDir: root })
    await git.init(['-b', 'main'])
    await git.addConfig('user.email', 'test@grove.local')
    await git.addConfig('user.name', 'Test')
    await git.addConfig('commit.gpgsign', 'false')
    await writeFile(join(root, 'a.txt'), 'base\n')
    await git.raw(['add', '-A'])
    await git.raw(['commit', '-m', 'base'])

    worktree = { id: 'wt-1', path: root, branch: 'main' } as Worktree
    versions = new VersionCounter()
    const registry = new RouteRegistry()
    const deps: GitRouteDeps = {
      versions,
      hub: new EventHub(),
      checkpoints: { list: () => [] } as unknown as CheckpointManager,
      repo: () => {
        throw new Error('not needed')
      },
      listWorktrees: async () => [worktree],
      createWorktree: async () => worktree,
      removeWorktree: async () => {},
      archiveWorktree: async () => {},
      confirmDangerous: async () => true
    }
    registerGitRoutes(registry, deps)
    dispatcher = new ApiDispatcher({
      registry,
      broker: { ensure: async () => {} } as unknown as PermissionBroker,
      findWorktree: () => worktree
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
    return dispatcher.invoke(client, `c-${method}-${Math.random()}`, method, params, {
      transport: 'worker'
    })
  }

  it('status reports version, dirty flag, and changed files', async () => {
    await writeFile(join(root, 'a.txt'), 'changed\n')
    const status = (await invoke('git.status', { worktreeId: 'wt-1' })) as {
      version: number
      dirty: boolean
      files: { path: string; staged: boolean }[]
    }
    expect(status.version).toBe(1)
    expect(status.dirty).toBe(true)
    expect(status.files.some((file) => file.path === 'a.txt')).toBe(true)
  })

  it('commit requires expectedStatusVersion', async () => {
    const attempt = invoke('git.commit', { worktreeId: 'wt-1', message: 'x' })
    await expect(attempt).rejects.toMatchObject({ code: 'invalid' })
  })

  it('commit with a stale version returns stale instead of committing', async () => {
    await writeFile(join(root, 'a.txt'), 'changed\n')
    await invoke('git.stage', { worktreeId: 'wt-1', paths: ['a.txt'] })
    // The stage bumped the version; a caller still holding 1 is stale.
    const result = (await invoke('git.commit', {
      worktreeId: 'wt-1',
      message: 'nope',
      expectedStatusVersion: 1
    })) as { status: string; currentVersion?: number }
    expect(result.status).toBe('stale')
    expect(result.currentVersion).toBe(2)
  })

  it('stage then commit with the fresh version succeeds', async () => {
    await writeFile(join(root, 'a.txt'), 'changed\n')
    const staged = (await invoke('git.stage', {
      worktreeId: 'wt-1',
      paths: ['a.txt'],
      expectedStatusVersion: 1
    })) as { status: string; version: number }
    expect(staged.status).toBe('ok')
    const committed = (await invoke('git.commit', {
      worktreeId: 'wt-1',
      message: 'update',
      expectedStatusVersion: staged.version
    })) as { status: string; result?: { sha: string } }
    expect(committed.status).toBe('ok')
    expect(committed.result?.sha.length).toBeGreaterThan(6)
  })

  it('diffFile returns sides and range hunks', async () => {
    await writeFile(join(root, 'a.txt'), 'changed\n')
    const diff = (await invoke('git.diffFile', { worktreeId: 'wt-1', path: 'a.txt' })) as {
      original: string
      modified: string
      hunks: unknown[]
    }
    expect(diff.original).toBe('base\n')
    expect(diff.modified).toBe('changed\n')
    expect(diff.hunks.length).toBeGreaterThan(0)
  })
})
