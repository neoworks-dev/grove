// workspace.* routes: file listing, read/write, ripgrep search. Path-taking
// routes declare scope null and go through broker.ensurePath themselves so
// the workspace grant + fsScopes prompting happens exactly once per call.

import { isAbsolute, join } from 'path'
import type { Worktree } from '../../../shared/types'
import * as files from '../../files'
import * as search from '../../search'
import { createStreamBatcher } from '../streamBatch'
import type { RouteRegistry, RouteContext } from '../registry'

function absolutePath(worktree: Worktree, path: string): string {
  if (isAbsolute(path)) return path
  return join(worktree.path, path)
}

async function readFileContent(
  args: Record<string, unknown>,
  context: RouteContext
): Promise<string> {
  const worktree = context.worktreeFor(args)
  const absPath = absolutePath(worktree, String(args.path ?? ''))
  await context.broker.ensurePath(context.client, 'read', absPath, worktree.path)
  return files.readFileContent(worktree.path, absPath)
}

export function registerWorkspaceRoutes(registry: RouteRegistry): void {
  registry.register({
    method: 'workspace.findFiles',
    scope: 'workspace.read',
    describe: (args, context) => `list files in ${context.worktreeFor(args).path}`,
    handler: async (args, context) => files.listAll(context.worktreeFor(args).path)
  })

  registry.register({
    method: 'workspace.readFile',
    scope: null,
    handler: (args, context) => readFileContent(args, context)
  })

  registry.register({
    method: 'workspace.readExcerpt',
    scope: null,
    handler: async (args, context) => {
      const content = await readFileContent(args, context)
      const startLine = Math.max(1, Number(args.startLine ?? 1))
      const endLine = Math.max(startLine, Number(args.endLine ?? startLine))
      const lines = content.split('\n')
      const excerpt: { n: number; text: string }[] = []
      for (let n = startLine; n <= Math.min(endLine, lines.length); n++) {
        excerpt.push({ n, text: lines[n - 1] })
      }
      return excerpt
    }
  })

  registry.register({
    method: 'workspace.writeFile',
    scope: null,
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const absPath = absolutePath(worktree, String(args.path ?? ''))
      await context.broker.ensurePath(context.client, 'write', absPath, worktree.path)
      await files.writeFileContent(worktree.path, absPath, String(args.content ?? ''))
    }
  })

  registry.register({
    method: 'workspace.searchText',
    scope: 'workspace.read',
    streaming: true,
    describe: (args, context) => `search in ${context.worktreeFor(args).path}`,
    handler: (args, context) =>
      new Promise<null>((resolve) => {
        const worktree = context.worktreeFor(args)
        const batcher = createStreamBatcher<search.SearchMatch>((items) => context.emit(items))
        const handle = search.ripgrepSearch(
          worktree.path,
          String(args.query ?? ''),
          (match) => batcher.push(match),
          () => {
            batcher.flush()
            resolve(null)
          }
        )
        context.signal.addEventListener('abort', () => handle.cancel())
      })
  })
}
