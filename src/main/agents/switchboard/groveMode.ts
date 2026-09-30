// Grove mode: a harness run with grove's prompt and grove's tools in place of
// its own, switched on per session.
//
// The harness keeps doing what it is best at — the model, the conversation,
// the turn loop — whether it is Claude Code, Codex or pi. Everything else it brings is switched off: its system prompt,
// its tools, the user's own configuration, its extras. What takes their place
// is written for working in grove and costs far fewer tokens a turn: a short
// prompt, and tools that read and edit by line tags, reach the editor's
// buffers and language servers, and run commands where the user can watch.

import type { Context } from '@neoworks/extension-system'
import type { Feature, SessionOptions } from '@neoworks/harness'
import type { GroveTool, HarnessRunOptions } from '../harness'
import { workspaceTools } from '../tools'
import { EditorWorkspaceFiles } from '../tools/workspaceFiles'
import { groveModePrompt } from './groveModePrompt'
import { effortOf, permissionPolicyOf } from './run'

const EXTRAS_OFF: Feature[] = [
  'subagents',
  'workflows',
  'todos',
  'scheduling',
  'worktrees',
  'plan_mode',
  'skills',
  'memory',
  'tool_search',
  'images'
]

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
    // Every extra but the agent asking the user: grove answers questions itself.
    disable: EXTRAS_OFF,
    permissions: permissionPolicyOf(options.permissionMode)
  }
  if (options.model) sessionOptions.model = options.model
  const effort = effortOf(options.thinkingLevel)
  if (effort) sessionOptions.effort = effort
  return sessionOptions
}

/** The workspace tools a grove mode session is served, made fresh for each session. */
export function groveModeTools(ctx: Context): GroveTool[] {
  const worktrees = (): { id: string; path: string }[] => ctx.workbench.worktrees
  const files = new EditorWorkspaceFiles(ctx.documents, worktrees)
  return workspaceTools({ files, languages: ctx.lsp, worktrees })
}
