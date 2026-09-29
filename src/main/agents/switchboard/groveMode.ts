// Grove mode: a harness run with grove's prompt and grove's tools in place of
// its own.
//
// The harness keeps doing what it is best at — the model, the conversation,
// the turn loop — on Claude Code, Codex or pi, whichever the model picked
// belongs to. Everything else it brings is switched off: its system prompt,
// its tools, the user's own configuration, its extras. What takes their place
// is written for working in grove and costs far fewer tokens a turn: a short
// prompt, and tools that read and edit by line tags, reach the editor's
// buffers and language servers, and run commands where the user can watch.

import type { Context } from '@neoworks/extension-system'
import type { SessionOptions } from '@neoworks/harness'
import type { HarnessRunOptions } from '../harness'
import { workspaceTools } from '../tools'
import { EditorWorkspaceFiles } from '../tools/workspaceFiles'
import { switchboardHarness } from './descriptor'
import { groveModePrompt } from './groveModePrompt'
import { CAPABILITIES } from './harnesses'
import type { SwitchboardHost } from './host'
import { effortOf, permissionPolicyOf } from './run'

/** The options a grove mode session runs with. */
export function groveModeOptions(options: HarnessRunOptions, today: Date = new Date()): SessionOptions {
  const prompt = groveModePrompt(
    {
      workspaceRoot: options.workspaceRoot,
      platform: process.platform,
      today: today.toISOString().slice(0, 10)
    },
    options.systemPrompt
  )
  const sessionOptions: SessionOptions = {
    systemPrompt: { replace: prompt },
    tools: 'none',
    isolation: 'full',
    disable: 'all',
    permissions: permissionPolicyOf(options.permissionMode)
  }
  if (options.model) sessionOptions.model = options.model
  const effort = effortOf(options.thinkingLevel)
  if (effort) sessionOptions.effort = effort
  return sessionOptions
}

export const groveMode = {
  name: 'main/harness/grove',
  inject: ['harnesses', 'switchboard', 'documents', 'lsp', 'workbench'],

  apply(ctx: Context): void {
    const host: SwitchboardHost = ctx.switchboard
    const worktrees = (): { id: string; path: string }[] => ctx.workbench.worktrees
    const files = new EditorWorkspaceFiles(ctx.documents, worktrees)

    ctx.effect(
      () =>
        ctx.harnesses.register(
          switchboardHarness(host, {
            id: 'grove',
            label: 'Grove',
            description:
              "Grove's own prompt and tools on Claude Code, Codex or pi: edits by line tags, the editor's language servers, far fewer tokens a turn.",
            icon: 'grove:grove',
            capabilities: CAPABILITIES,
            runsOn: ['claude', 'codex', 'pi'],
            profile: () => ({ sessionOptions: (options) => groveModeOptions(options) }),
            tools: () => workspaceTools({ files, languages: ctx.lsp, worktrees })
          })
        ),
      'harness:grove'
    )
  }
}
