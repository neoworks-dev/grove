import { describe, it, expect } from 'bun:test'
import { RouteRegistry, type RouteDefinition } from '../src/main/api/registry'
import { PLUGIN_PERMISSIONS, PERMISSION_META } from '../sdk/src/protocol'
import { registerWorkspaceRoutes } from '../src/main/api/routes/workspace'
import { registerStorageRoutes } from '../src/main/api/routes/storage'
import { registerAiRoutes } from '../src/main/api/routes/ai'
import { registerEventRoutes } from '../src/main/api/routes/events'
import { registerEditorRoutes } from '../src/main/api/routes/editor'
import { registerGitRoutes } from '../src/main/api/routes/git'
import { registerLanguagesRoutes } from '../src/main/api/routes/languages'
import { registerServicesRoutes } from '../src/main/api/routes/services'
import { registerAgentsRoutes } from '../src/main/api/routes/agents'
import { registerTerminalsRoutes } from '../src/main/api/routes/terminals'
import { EventHub } from '../src/main/api/events'

// Routes where scope: null is deliberate: the handler runs its own check
// (ensurePath / AiBridge prompts / per-topic event gating).
const SELF_GATED = new Set([
  'workspace.readFile',
  'workspace.readExcerpt',
  'workspace.writeFile',
  'ai.registerMcpServer',
  'ai.disposeMcpServer',
  'ai.registerSkill',
  'ai.disposeSkill',
  'ai.prompt',
  'events.subscribe',
  // languages mutations: gated on languages.read via scope + editor.edit in-handler
  'storage.get',
  'storage.set',
  'storage.delete'
])

const DANGER_ROUTES: Record<string, string> = {
  'terminals.create': 'terminal.exec',
  'terminals.write': 'terminal.exec',
  'terminals.read': 'terminal.exec',
  'terminals.kill': 'terminal.exec',
  'agents.send': 'agents.run',
  'agents.createChat': 'agents.run',
  'agents.sendChannelMessage': 'agents.run',
  'git.worktrees.create': 'worktrees.manage',
  'git.worktrees.remove': 'worktrees.manage',
  'git.worktrees.archive': 'worktrees.manage'
}

function fullRegistry(): RouteRegistry {
  const registry = new RouteRegistry()
  const anyDeps = new Proxy(
    {},
    { get: () => () => undefined }
  ) as never
  registerWorkspaceRoutes(registry)
  registerStorageRoutes(registry, { storagePath: () => '/tmp/x.json' })
  registerAiRoutes(registry, anyDeps)
  registerEventRoutes(registry, { hub: new EventHub() })
  registerEditorRoutes(registry, anyDeps)
  registerGitRoutes(registry, anyDeps)
  registerLanguagesRoutes(registry, anyDeps)
  registerServicesRoutes(registry, anyDeps)
  registerAgentsRoutes(registry, { hub: new EventHub() } as never)
  registerTerminalsRoutes(registry, anyDeps)
  return registry
}

describe('route → scope table', () => {
  const registry = fullRegistry()
  const routes = registry.methods().map((method) => registry.get(method) as RouteDefinition)

  it('registers a substantial route surface', () => {
    expect(routes.length).toBeGreaterThan(40)
  })

  it('every route declares a valid scope or is explicitly self-gated', () => {
    for (const route of routes) {
      if (route.scope === null) {
        expect(SELF_GATED.has(route.method)).toBe(true)
        continue
      }
      expect(PLUGIN_PERMISSIONS).toContain(route.scope)
    }
  })

  it('danger routes sit on danger-tier scopes', () => {
    for (const [method, expectedScope] of Object.entries(DANGER_ROUTES)) {
      const route = registry.get(method)
      expect(route).not.toBeNull()
      expect(route?.scope).toBe(expectedScope as never)
      expect(PERMISSION_META[expectedScope as keyof typeof PERMISSION_META].risk).toBe('danger')
    }
  })

  it('no route uses reserved scopes', () => {
    for (const route of routes) {
      expect(route.scope).not.toBe('shell')
      expect(route.scope).not.toBe('net')
    }
  })
})
