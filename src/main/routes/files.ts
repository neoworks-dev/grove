// File tree and file contents inside a worktree.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import * as files from '../files'

export const filesRoutes = {
  name: 'main/routes/files',
  inject: ['workbench'],

  apply(ctx: Context): void {
    // ── Files ─────────────────────────────────────────────────────
    route(ctx, 'files:listDir', (_e, worktreeId: string, relPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.listDir(worktree.path, relPath)
    })

    route(ctx, 'files:listAll', (_e, worktreeId: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.listAll(worktree.path)
    })

    // Arbitrary-directory listing for @ path completion (may leave the worktree).
    route(ctx, 'files:listPath', (_e, worktreeId: string, rawPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.listPath(worktree.path, rawPath)
    })

    route(ctx, 'files:read', (_e, worktreeId: string, absPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.readFileContent(worktree.path, absPath)
    })

    route(ctx, 'files:write', (_e, worktreeId: string, absPath: string, content: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.writeFileContent(worktree.path, absPath, content)
    })

    // Save a pasted/dropped attachment for @-mentioning in the agent prompt.
    route(ctx, 'files:saveAttachment', (_e, worktreeId: string, data: Uint8Array, ext: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.saveAttachment(worktree.path, data, ext)
    })

    route(ctx, 'files:create', (_e, worktreeId: string, relPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.createFile(worktree.path, relPath)
    })

    route(ctx, 'files:createDir', (_e, worktreeId: string, relPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.createDir(worktree.path, relPath)
    })

    route(ctx, 'files:rename', (_e, worktreeId: string, fromRel: string, toRel: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.renamePath(worktree.path, fromRel, toRel)
    })

    route(ctx, 'files:delete', (_e, worktreeId: string, relPath: string) => {
      const worktree = ctx.workbench.findWorktree(worktreeId)
      return files.removePath(worktree.path, relPath)
    })
  }
}
