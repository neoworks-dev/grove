// "Fix with agent": hands a problem the user ran into — a diagnostic, a failed
// command — to an agent, instead of the user copying the error and its location
// into the composer. It goes to the agent that owns the problem's worktree, or
// to a new one, whichever the user picks from the action's menu.

import type { MenuItem } from '../../components/ContextMenu.svelte'
import type { Diagnostic } from '../diagnostics.svelte'
import { dialogs } from '../dialogs.svelte'
import { layout } from '../layout.svelte'
import { focusAgentInPane, store } from '../store.svelte'
import type { Worktree } from '../../../../shared/types'
import { agentSessions } from './sessions.svelte'
import { startSessionWithMessage } from './newSession'
import {
  CONTEXT_RADIUS,
  fixMessage,
  severityName,
  surroundingCode,
  type CodeSlice,
  type FixDiagnostic,
  type FixProblem
} from './fixPrompt'

/** Who a problem goes to: a session the worktree already has, or one started for it. */
export type FixTarget = { kind: 'session'; sessionId: string; title: string } | { kind: 'new' }

/** Longest session title a menu entry names before it is cut short. */
const MAX_TITLE_LENGTH = 32

/** The agents a worktree's problem can go to: its own, if it has one, then a new one. */
export function fixTargets(worktreePath: string): FixTarget[] {
  const targets: FixTarget[] = []
  const sessionId = agentSessions.resolveActive(worktreePath)
  if (sessionId) {
    const session = agentSessions.list.find((candidate) => candidate.id === sessionId)
    let title = ''
    if (session) {
      title = session.title
    }
    targets.push({ kind: 'session', sessionId, title })
  }
  targets.push({ kind: 'new' })
  return targets
}

/** What a target's menu entry says. */
export function fixTargetLabel(target: FixTarget): string {
  if (target.kind === 'new') {
    return 'Fix with new agent'
  }
  if (!target.title) {
    return 'Fix with agent'
  }
  let title = target.title
  if (title.length > MAX_TITLE_LENGTH) {
    title = `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`
  }
  return `Fix with agent: ${title}`
}

/**
 * Menu entries handing a problem to each of a worktree's targets. The problem is
 * only read once an entry is picked, so opening the menu costs nothing.
 */
export function fixMenuItems(
  worktreePath: string,
  loadProblem: () => Promise<FixProblem | null>
): MenuItem[] {
  return fixTargets(worktreePath).map((target) => ({
    label: fixTargetLabel(target),
    action: () => void fixLoaded(worktreePath, loadProblem, target)
  }))
}

/** Reads the problem, then hands it over; a problem gone by then is dropped. */
async function fixLoaded(
  worktreePath: string,
  loadProblem: () => Promise<FixProblem | null>,
  target: FixTarget
): Promise<void> {
  const problem = await loadProblem()
  if (!problem) {
    return
  }
  await fixWithAgent(worktreePath, problem, target)
}

/** Sends a problem to its target and brings the conversation into view. */
export async function fixWithAgent(
  worktreePath: string,
  problem: FixProblem,
  target: FixTarget
): Promise<void> {
  const content = fixMessage(problem)
  if (target.kind === 'new') {
    const started = await startSessionWithMessage(worktreePath, content)
    if (!started) {
      dialogs.notify({ level: 'error', message: 'Could not start an agent to fix this' })
    }
    return
  }
  await focusAgentInPane(worktreePath, target.sessionId)
  layout.ensurePane('agent')
  await agentSessions.send(target.sessionId, [
    { type: 'user.message', content, deliverAs: 'steer' }
  ])
}

/** The worktree holding an absolute path, the innermost when worktrees nest. */
export function worktreeForPath(absolutePath: string): Worktree | null {
  let found: Worktree | null = null
  for (const worktree of store.worktrees) {
    if (!absolutePath.startsWith(`${worktree.path}/`)) {
      continue
    }
    if (found && found.path.length > worktree.path.length) {
      continue
    }
    found = worktree
  }
  return found
}

/** An absolute path as the worktree sees it, or unchanged when it lies outside. */
export function relativeToWorktree(worktreePath: string, absolutePath: string): string {
  if (!absolutePath.startsWith(`${worktreePath}/`)) {
    return absolutePath
  }
  return absolutePath.slice(worktreePath.length + 1)
}

/** The editor's diagnostics on the cursor line, as the bundled config's grove_fix_context reads them. */
export interface EditorFixContext {
  path: string
  diagnostics: Diagnostic[]
  startLine: number
  endLine: number
  text: string
}

/** The problem an editor line's diagnostics describe, with the code nvim read around them. */
export function editorProblem(worktreePath: string, context: EditorFixContext): FixProblem {
  return {
    kind: 'diagnostic',
    path: relativeToWorktree(worktreePath, context.path),
    diagnostics: context.diagnostics.map(fixDiagnostic),
    code: { startLine: context.startLine, endLine: context.endLine, text: context.text }
  }
}

/** Reads an editor's cursor-line problem, or null when the line has no diagnostics any more. */
export async function readEditorProblem(
  nvimId: string,
  worktreePath: string
): Promise<FixProblem | null> {
  let context: EditorFixContext | null = null
  try {
    context = (await window.workbench.nvim.request(nvimId, 'nvim_exec_lua', [
      'return grove_fix_context(...)',
      [CONTEXT_RADIUS]
    ])) as EditorFixContext | null
  } catch {
    return null
  }
  if (!context) {
    return null
  }
  return editorProblem(worktreePath, context)
}

/** A collected diagnostic, 0-based, as the 1-based one an agent reads. */
function fixDiagnostic(diagnostic: Diagnostic): FixDiagnostic {
  return {
    line: diagnostic.lnum + 1,
    column: diagnostic.col + 1,
    severity: severityName(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source
  }
}

/**
 * The problem one or more diagnostics in a file describe, with the code around
 * the first of them as the file is on disk. The code is left out when the file
 * can't be read; the diagnostics alone still say what to fix.
 */
export async function diagnosticProblem(
  worktreePath: string,
  path: string,
  diagnostics: Diagnostic[]
): Promise<FixProblem> {
  const relativePath = relativeToWorktree(worktreePath, path)
  const listed = diagnostics.map(fixDiagnostic)
  let code: CodeSlice | null = null
  try {
    const content = await window.workbench.files.read(worktreePath, path)
    code = surroundingCode(content, listed[0].line)
  } catch {
    code = null
  }
  return { kind: 'diagnostic', path: relativePath, diagnostics: listed, code }
}
