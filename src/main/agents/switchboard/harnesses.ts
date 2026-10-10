// Claude Code, Codex and pi, each as switchboard runs it.
//
// As they come, these run their own system prompt with grove's part appended,
// their own tools and the user's own configuration; grove's tools reach them
// over MCP. A session in grove mode (`groveMode.ts`) runs the same harness on
// grove's prompt and workspace tools instead.

import type { Context } from '@neoworks/extension-system'
import type { BuiltinTool, SessionOptions } from '@neoworks/harness'
import type { HarnessCapabilities } from '../../../shared/agents'
import type { GroveTool, HarnessRunOptions } from '../harness'
import { claudeModels, sessionEnvironment, type CredentialSource } from './claudeModels'
import { switchboardHarness } from './descriptor'
import { groveModeTools } from './groveMode'
import { effortOf, permissionPolicyOf } from './run'
import { groveAddendum } from '../systemPrompt'
import type { EndpointsService } from '../../endpoints'
import type { SwitchboardHost } from './host'

const BUILTIN_TOOLS: BuiltinTool[] = ['read', 'write', 'edit', 'shell', 'web_search', 'web_fetch']

/**
 * What a harness can do under switchboard. Steering and live model changes
 * depend on the switchboard version, so a run looks for them before it uses
 * them and reports what it could not do.
 */
export const CAPABILITIES: HarnessCapabilities = {
  approvals: true,
  interrupt: true,
  liveModelSwitch: true,
  thinking: true,
  fastMode: false,
  steering: true,
  groveTools: true,
  groveMode: true,
  attachments: true,
  rewind: true
}

/** The options a harness runs with as it comes, grove's part of the prompt appended. */
export function nativeOptions(options: HarnessRunOptions): SessionOptions {
  const sessionOptions: SessionOptions = {
    systemPrompt: { append: groveAddendum(options.tools, options.systemPrompt) },
    permissions: permissionPolicyOf(options.permissionMode)
  }
  if (options.model) sessionOptions.model = options.model
  const effort = effortOf(options.thinkingLevel)
  if (effort) sessionOptions.effort = effort
  const tools = builtinToolsOf(options.activeTools)
  if (tools) sessionOptions.tools = tools
  return sessionOptions
}

/** A session's tool allow-list in switchboard's vocabulary, or null for none. */
function builtinToolsOf(activeTools: string[] | null): BuiltinTool[] | null {
  if (activeTools === null) return null
  return BUILTIN_TOOLS.filter((tool) => activeTools.includes(tool))
}

/** Claude's route variables as switchboard takes them: set, or emptied. */
async function claudeEnvironment(
  options: HarnessRunOptions,
  credentials: CredentialSource,
  endpoints: EndpointsService
): Promise<Record<string, string> | undefined> {
  const variables = await sessionEnvironment(options.provider, credentials, endpoints)
  if (!variables) return undefined
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(variables)) {
    // Unset is spelled empty: a variable grove's own environment carries has
    // to be cleared, not left to leak to another provider.
    let spelled = ''
    if (value !== undefined) spelled = value
    environment[name] = spelled
  }
  return environment
}

export const switchboardHarnesses = {
  name: 'main/harness/switchboard',
  inject: ['harnesses', 'switchboard', 'secrets', 'endpoints', 'documents', 'lsp', 'workbench'],

  apply(ctx: Context): void {
    const host: SwitchboardHost = ctx.switchboard
    const workspaceTools = (): GroveTool[] => groveModeTools(ctx)

    ctx.effect(
      () =>
        ctx.harnesses.register(
          switchboardHarness(host, {
            id: 'claude',
            label: 'Claude Code',
            description: "Anthropic's Claude Code, with its own tools and your own setup.",
            icon: 'grove:claude',
            // Claude's harness is the one that has a fast mode to switch.
            capabilities: { ...CAPABILITIES, fastMode: true },
            runsOn: ['claude'],
            profile: () => ({
              sessionOptions: nativeOptions,
              environment: (options) => claudeEnvironment(options, ctx.secrets, ctx.endpoints)
            }),
            models: (_harness, listed) => claudeModels(listed, ctx.secrets, ctx.endpoints),
            groveModeTools: workspaceTools
          })
        ),
      'harness:claude'
    )

    ctx.effect(
      () =>
        ctx.harnesses.register(
          switchboardHarness(host, {
            id: 'codex',
            label: 'Codex',
            description: "OpenAI's Codex, with its own tools and your own setup.",
            icon: 'grove:codex',
            capabilities: CAPABILITIES,
            runsOn: ['codex'],
            profile: () => ({ sessionOptions: nativeOptions }),
            groveModeTools: workspaceTools
          })
        ),
      'harness:codex'
    )

    ctx.effect(
      () =>
        ctx.harnesses.register(
          switchboardHarness(host, {
            id: 'pi',
            label: 'pi',
            description: 'The pi coding agent, with its own tools and your own setup.',
            icon: 'grove:pi',
            capabilities: CAPABILITIES,
            runsOn: ['pi'],
            profile: () => ({ sessionOptions: nativeOptions }),
            groveModeTools: workspaceTools
          })
        ),
      'harness:pi'
    )
  }
}
