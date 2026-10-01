// grove's own tools, served over MCP to whichever harness a session runs on.
//
// They run in grove's own process, so `send_message` posts on the worktree
// channel directly and the workspace tools read the editor's buffers. A
// harness that cannot host tools is given none and loses only the features
// they add.

import type { WorktreeChannel } from '../../worktreeChannel'
import type { GroveSkill, GroveTool } from '../harness'
import type { AgentRoster } from '../roster'
import { chatTools } from './chatTools'
import { conflictTool, type ConflictProposalSink } from './conflictTools'
import { fileTools } from './fileTools'
import { lspTool, renameTool, type AgentLanguages } from './lspTools'
import { searchTools } from './searchTools'
import { shellTool } from './shellTool'
import type { WorkspaceFiles, WorktreeLocation } from './workspaceFiles'
import { noteTools, type AgentNotes } from './noteTools'
import { showTools, type AgentScreen } from './showTools'
import { runtimesTool, spawnTool } from './spawnTools'
import { callTool, toolSearchTool } from './toolSearchTools'
import { transcriptTools } from './transcriptTools'
import { worktreeTools, type AgentWorktrees } from './worktreeTools'

export interface GroveToolOptions {
  chat: WorktreeChannel
  /** Who else is working in this worktree, and how to reach or start one. */
  roster: AgentRoster
  /** Each session's notes list. */
  notes: AgentNotes
  /** What the renderer can put on screen. */
  screen: AgentScreen
  /** The repository's worktrees, to list, create and spawn agents into. */
  worktrees: AgentWorktrees
  /** Where proposed merge-conflict resolutions wait for the user. */
  conflicts: ConflictProposalSink
  /** The skills plugins registered, which `tool_search` reads out on demand. */
  skills: () => GroveSkill[]
  now?: () => number
}

/** Every tool grove contributes, in the order they are offered to a harness. */
export function groveTools(options: GroveToolOptions): GroveTool[] {
  return [
    toolSearchTool(options.skills),
    ...showTools(options.screen),
    ...noteTools(options.notes),
    ...chatTools(options),
    runtimesTool(options.roster),
    spawnTool(options.roster, options.worktrees),
    ...transcriptTools(options.roster),
    ...worktreeTools(options.worktrees),
    conflictTool(options.conflicts)
  ]
}

export interface WorkspaceToolOptions {
  files: WorkspaceFiles
  languages: AgentLanguages
  worktrees: () => WorktreeLocation[]
}

/**
 * The tools grove mode works with in place of a harness's own: reading and
 * editing files, finding them, asking the language server, running commands,
 * and calling whatever tool is listed by name only. Made per session, since
 * the edit tool remembers what it was last asked.
 */
export function workspaceTools(options: WorkspaceToolOptions): GroveTool[] {
  return [
    ...fileTools(options.files),
    ...searchTools(),
    lspTool(options.languages, options.files, options.worktrees),
    renameTool(options.languages, options.files, options.worktrees),
    shellTool(),
    callTool()
  ]
}
