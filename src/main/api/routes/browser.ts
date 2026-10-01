// browser.* routes: a browser provider (Kit, or Chrome through Grove's
// extension) handing Grove a tab per worktree, which the
// agents' browser tool then drives. Socket-only, because Grove talks back down
// the provider's own connection (`browser.cdp`, `browser.open`). The protocol
// is neoworks-dev/grove#353; its types are in sdk/src/protocol.ts.

import type { BrowserProvideParams, BrowserWorktree } from '../../../../sdk/src/protocol'
import type { Worktree } from '../../../shared/types'
import type { BrowserProviderService } from '../../browserProviders'
import { ApiError, type ApiConnection, type RouteContext, type RouteRegistry } from '../registry'

interface BrowserRouteDeps {
  providers: BrowserProviderService
  /** The open repository's worktrees; empty when none is open. */
  worktrees: () => Worktree[]
}

export function registerBrowserRoutes(registry: RouteRegistry, deps: BrowserRouteDeps): void {
  registry.register({
    method: 'browser.worktrees',
    scope: 'browser.provide',
    transports: ['socket'],
    describe: () => 'list the worktrees it can offer a browser tab to',
    handler: async (_args, context) => {
      deps.providers.connected(connectionOf(context))
      return deps.worktrees().map(browserWorktreeOf)
    }
  })

  registry.register({
    method: 'browser.provide',
    scope: 'browser.provide',
    transports: ['socket'],
    describe: (args) => `hand its tab to the agents in ${String(args.worktreeId)}`,
    handler: async (args, context) => {
      const params = provideParamsOf(args, deps.worktrees())
      deps.providers.provide(connectionOf(context), params)
      return null
    }
  })

  registry.register({
    method: 'browser.withdraw',
    scope: 'browser.provide',
    transports: ['socket'],
    describe: (args) => `take its tab back from ${String(args.worktreeId)}`,
    handler: async (args, context) => {
      deps.providers.withdraw(connectionOf(context), String(args.worktreeId))
      return null
    }
  })
}

/** The connection a call came in on; the routes are socket-only, so there always is one. */
function connectionOf(context: RouteContext): ApiConnection {
  if (!context.connection) throw new ApiError('browser routes need a socket connection', 'unsupported')
  return context.connection
}

/** A worktree as a browser sees it. */
function browserWorktreeOf(worktree: Worktree): BrowserWorktree {
  return { id: worktree.id, name: worktree.name, branch: worktree.branch, path: worktree.path }
}

/** `browser.provide`'s arguments, checked: a known worktree and a tab with a url. */
function provideParamsOf(args: Record<string, unknown>, worktrees: Worktree[]): BrowserProvideParams {
  const worktreeId = args.worktreeId
  if (typeof worktreeId !== 'string' || !worktrees.some((worktree) => worktree.id === worktreeId)) {
    throw new ApiError(`unknown worktree: ${String(worktreeId)}`, 'invalid')
  }
  const tab = args.tab as { url?: unknown; title?: unknown } | undefined
  if (!tab || typeof tab.url !== 'string') {
    throw new ApiError('browser.provide needs tab: { url, title }', 'invalid')
  }
  let title = ''
  if (typeof tab.title === 'string') title = tab.title
  return { worktreeId, tab: { url: tab.url, title } }
}
