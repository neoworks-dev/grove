// grove's own tools, offered to every harness that can host them.
//
// These used to be extensions loaded into the agent server, which meant they
// could not call back into grove and had to reach it through files. Now they run
// in grove's own process, so `send_message` posts on the worktree channel
// directly.
//
// Each harness adapter translates these into whatever its SDK calls a tool. A
// harness that cannot host tools is given none and loses only the features they
// add.

import type { WorktreeChannel } from '../../worktreeChannel'
import type { GroveTool } from '../harness'
import type { AgentRoster } from '../roster'
import { chatTools } from './chatTools'
import { noteTools, type AgentNotes } from './noteTools'
import { requestReviewTool } from './reviewTools'
import { showTools, type AgentScreen } from './showTools'
import { runtimesTool, spawnTool } from './spawnTools'
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
  now?: () => number
}

/** Every tool grove contributes, in the order they are offered to a harness. */
export function groveTools(options: GroveToolOptions): GroveTool[] {
  return [
    requestReviewTool(),
    ...showTools(options.screen),
    ...noteTools(options.notes),
    ...chatTools(options),
    runtimesTool(options.roster),
    spawnTool(options.roster, options.worktrees),
    ...transcriptTools(options.roster),
    ...worktreeTools(options.worktrees)
  ]
}
