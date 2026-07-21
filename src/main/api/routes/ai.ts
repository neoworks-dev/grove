// ai.* routes. Scope checks live inside AiBridge (it prompts with richer,
// per-declaration detail), so these routes declare scope null. Registration
// routes are worker-only: their tool handlers live in the plugin's worker
// and cannot be proxied to a socket client.

import type { AiBridge, McpServerDeclaration, SkillDeclaration } from '../../plugins/aiBridge'
import type { RouteRegistry } from '../registry'

interface AiDeps {
  aiBridge: AiBridge
}

export function registerAiRoutes(registry: RouteRegistry, deps: AiDeps): void {
  registry.register({
    method: 'ai.registerMcpServer',
    scope: null,
    transports: ['worker'],
    handler: (args, context) =>
      deps.aiBridge.registerMcpServer(context.client, args as unknown as McpServerDeclaration)
  })

  registry.register({
    method: 'ai.disposeMcpServer',
    scope: null,
    transports: ['worker'],
    handler: async (args, context) =>
      deps.aiBridge.disposeMcpServer(context.client.id, String(args.name ?? args.id ?? ''))
  })

  registry.register({
    method: 'ai.registerSkill',
    scope: null,
    transports: ['worker'],
    handler: (args, context) =>
      deps.aiBridge.registerSkill(context.client, args as unknown as SkillDeclaration)
  })

  registry.register({
    method: 'ai.disposeSkill',
    scope: null,
    transports: ['worker'],
    handler: async (args, context) =>
      deps.aiBridge.disposeSkill(context.client.id, String(args.name ?? args.id ?? ''))
  })

  registry.register({
    method: 'ai.prompt',
    scope: null,
    streaming: true,
    handler: (args, context) =>
      deps.aiBridge.runPrompt(
        context.client,
        args as { prompt: string; model?: string; systemAppend?: string },
        context.worktreeFor(args),
        { emit: context.emit, signal: context.signal }
      )
  })
}
