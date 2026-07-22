// git.* routes: status, diffs, staging, commits, worktrees, checkpoints.
// The per-worktree statusVersion is a generation counter bumped by the fs
// watcher and by every Grove-initiated mutation; commit requires the version
// the caller read so a client can never commit a staged set it didn't see.
// Destructive verbs (worktree remove, checkpoint restore) additionally
// require a native confirmation dialog the client cannot answer.

import type { Worktree, WorkbenchConfig, DiffFile } from '../../../shared/types'
import * as git from '../../git'
import type { CheckpointManager } from '../../checkpoints'
import type { EventHub } from '../events'
import { VersionCounter, isStale } from '../versions'
import { ApiError, type RouteRegistry, type RouteContext } from '../registry'

export interface GitRouteDeps {
  versions: VersionCounter
  hub: EventHub
  checkpoints: CheckpointManager
  repo: () => { repoPath: string; config: WorkbenchConfig }
  listWorktrees: () => Promise<Worktree[]>
  createWorktree: (options: { branch: string; base?: string }) => Promise<Worktree>
  removeWorktree: (worktree: Worktree) => Promise<void>
  archiveWorktree: (worktree: Worktree) => Promise<void>
  // Native (main-process) confirmation the calling client cannot answer.
  confirmDangerous: (title: string, detail: string) => Promise<boolean>
}

type StaleResult = { status: 'stale'; currentVersion: number }

export function registerGitRoutes(registry: RouteRegistry, deps: GitRouteDeps): void {
  const staleOr = (
    worktree: Worktree,
    expected: number | undefined
  ): StaleResult | null => {
    const current = deps.versions.current(worktree.id)
    if (isStale(current, expected)) return { status: 'stale', currentVersion: current }
    return null
  }

  const bumpAndPublish = (worktree: Worktree): number => {
    const version = deps.versions.bump(worktree.id)
    deps.hub.publish({
      topic: 'git.didChangeStatus',
      payload: { worktreeId: worktree.id, version },
      worktreeId: worktree.id
    })
    return version
  }

  // ── Read ──────────────────────────────────────────────────────
  registry.register({
    method: 'git.status',
    scope: 'git.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const [dirty, files] = await Promise.all([
        git.isDirty(worktree.path),
        git.changedFiles(worktree.path)
      ])
      return {
        worktreeId: worktree.id,
        branch: worktree.branch,
        dirty,
        version: deps.versions.current(worktree.id),
        files: files.map((file) => ({
          path: file.path,
          status: file.changeType,
          staged: file.staged
        }))
      }
    }
  })

  registry.register({
    method: 'git.branches',
    scope: 'git.read',
    handler: async () => {
      const { repoPath } = deps.repo()
      const branches = await git.listBranches(repoPath)
      return { current: branches.current, all: branches.all }
    }
  })

  registry.register({
    method: 'git.diffFile',
    scope: 'git.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const file = await resolveDiffFile(worktree, String(args.path ?? ''), args.staged === true)
      const [sides, hunks] = await Promise.all([
        git.diffSides(worktree.path, file),
        git.diffHunks(worktree.path, file)
      ])
      return {
        original: sides.original,
        modified: sides.modified,
        language: sides.language,
        hunks: hunks.hunks
      }
    }
  })

  registry.register({
    method: 'git.fileAtRef',
    scope: 'git.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      return git.fileAtRef(worktree.path, String(args.ref ?? 'HEAD'), String(args.path ?? ''))
    }
  })

  // ── Write ─────────────────────────────────────────────────────
  registry.register({
    method: 'git.stage',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const stale = staleOr(worktree, optionalVersion(args.expectedStatusVersion))
      if (stale) return stale
      await git.stage(worktree.path, stringArray(args.paths))
      return { status: 'ok', version: bumpAndPublish(worktree) }
    }
  })

  registry.register({
    method: 'git.unstage',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const stale = staleOr(worktree, optionalVersion(args.expectedStatusVersion))
      if (stale) return stale
      await git.unstage(worktree.path, stringArray(args.paths))
      return { status: 'ok', version: bumpAndPublish(worktree) }
    }
  })

  registry.register({
    method: 'git.commit',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const expected = optionalVersion(args.expectedStatusVersion)
      if (expected === undefined) {
        throw new ApiError('git.commit requires expectedStatusVersion', 'invalid')
      }
      const stale = staleOr(worktree, expected)
      if (stale) return stale
      const sha = await git.commit(worktree.path, String(args.message ?? ''))
      return { status: 'ok', version: bumpAndPublish(worktree), result: { sha } }
    }
  })

  registry.register({
    method: 'git.push',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      try {
        await git.push(worktree.path)
        return { status: 'ok' }
      } catch (error) {
        // The remote is the arbiter (non-fast-forward etc.) — surface the
        // rejection as a result, not a transport error.
        return { status: 'rejected', reason: (error as Error).message }
      }
    }
  })

  // ── Worktrees ─────────────────────────────────────────────────
  registry.register({
    method: 'git.worktrees.list',
    scope: 'git.read',
    handler: async () => {
      const worktrees = await deps.listWorktrees()
      return worktrees.map((worktree) => ({
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch
      }))
    }
  })

  registry.register({
    method: 'git.worktrees.create',
    scope: 'worktrees.manage',
    handler: async (args, context) => {
      const branch = String(args.branch ?? '')
      if (branch.length === 0) throw new ApiError('branch is required', 'invalid')
      const base = args.base === undefined ? undefined : String(args.base)
      const created = await deps.createWorktree({ branch, base })
      publishWorktreesChanged(deps.hub, context)
      return { id: created.id, path: created.path, branch: created.branch }
    }
  })

  registry.register({
    method: 'git.worktrees.remove',
    scope: 'worktrees.manage',
    handler: async (args, context) => {
      const worktree = await namedWorktree(deps, String(args.worktreeId ?? ''))
      const confirmed = await deps.confirmDangerous(
        `Remove worktree "${worktree.name}"?`,
        `Requested by ${context.client.name}. This deletes ${worktree.path}.`
      )
      if (!confirmed) throw new ApiError('worktree removal not confirmed', 'permission-denied')
      await deps.removeWorktree(worktree)
      publishWorktreesChanged(deps.hub, context)
    }
  })

  registry.register({
    method: 'git.worktrees.archive',
    scope: 'worktrees.manage',
    handler: async (args, context) => {
      const worktree = await namedWorktree(deps, String(args.worktreeId ?? ''))
      const confirmed = await deps.confirmDangerous(
        `Archive worktree "${worktree.name}"?`,
        `Requested by ${context.client.name}. This removes ${worktree.path} and deletes its branch.`
      )
      if (!confirmed) throw new ApiError('worktree archive not confirmed', 'permission-denied')
      await deps.archiveWorktree(worktree)
      publishWorktreesChanged(deps.hub, context)
    }
  })

  // ── Checkpoints ───────────────────────────────────────────────
  registry.register({
    method: 'git.checkpoints.list',
    scope: 'git.read',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      return deps.checkpoints.list(worktree.path).map((meta) => ({
        id: meta.commit,
        label: meta.note ?? meta.trigger,
        createdAt: meta.ts
      }))
    }
  })

  registry.register({
    method: 'git.checkpoints.snapshot',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const label = args.label === undefined ? undefined : String(args.label)
      const meta = await deps.checkpoints.snapshot(worktree.path, 'manual', { note: label })
      if (!meta) throw new ApiError('nothing to snapshot', 'invalid')
      deps.hub.publish({
        topic: 'checkpoints.didChange',
        payload: { worktreeId: worktree.id },
        worktreeId: worktree.id
      })
      return { id: meta.commit }
    }
  })

  registry.register({
    method: 'git.checkpoints.restore',
    scope: 'git.write',
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const checkpointId = String(args.checkpointId ?? '')
      const confirmed = await deps.confirmDangerous(
        `Restore checkpoint on "${worktree.name}"?`,
        `Requested by ${context.client.name}. Uncommitted work is replaced by the checkpoint (a safety checkpoint is taken first).`
      )
      if (!confirmed) throw new ApiError('restore not confirmed', 'permission-denied')
      await deps.checkpoints.restore(worktree.path, checkpointId)
      bumpAndPublish(worktree)
      deps.hub.publish({
        topic: 'checkpoints.didChange',
        payload: { worktreeId: worktree.id },
        worktreeId: worktree.id
      })
    }
  })
}

async function resolveDiffFile(
  worktree: Worktree,
  path: string,
  staged: boolean
): Promise<DiffFile> {
  const changed = await git.changedFiles(worktree.path)
  const match = changed.find((file) => file.path === path && file.staged === staged)
  if (match) return match
  const anySide = changed.find((file) => file.path === path)
  if (anySide) return anySide
  return { path, changeType: 'modified', staged }
}

async function namedWorktree(deps: GitRouteDeps, worktreeId: string): Promise<Worktree> {
  const worktrees = await deps.listWorktrees()
  const worktree = worktrees.find((entry) => entry.id === worktreeId)
  if (!worktree) throw new ApiError(`unknown worktree: ${worktreeId}`, 'invalid')
  return worktree
}

function publishWorktreesChanged(hub: EventHub, context: RouteContext): void {
  hub.publish({
    topic: 'worktrees.didChange',
    payload: { by: context.client.key }
  })
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return Number(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(String)
}
