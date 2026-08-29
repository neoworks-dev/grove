// Debug harness client. Attaches to a running Grove and inspects or drives it,
// so UI behaviour can be diagnosed directly instead of described.
//
// Grove must have been started with GROVE_DEBUG=1, otherwise the debug.* routes
// are not registered at all. Approve the pairing dialog on first run; the token
// is reused from ~/.config/grove/tokens/grove-debug afterwards.
//
//   bun scripts/grove-debug.ts windows
//   bun scripts/grove-debug.ts lua 'return vim.api.nvim_get_current_buf()'
//   bun scripts/grove-debug.ts eval 'review.active?.files.length'
//   bun scripts/grove-debug.ts state
//   bun scripts/grove-debug.ts scenario review-gated
//   bun scripts/grove-debug.ts scenarios

import { connectGrove, type GroveClient } from '../sdk/src/client/node'
import { SCENARIOS } from './debug/scenarios'
import { evaluate, windows } from './debug/client'
import * as agent from './debug/agent'

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help') {
    usage()
    return
  }
  if (command === 'scenarios') {
    for (const scenario of SCENARIOS)
      console.log(`${scenario.name.padEnd(18)} ${scenario.describe}`)
    return
  }

  const grove = await connect()
  try {
    await run(grove, command, rest)
  } finally {
    grove.close()
  }
}

async function run(grove: GroveClient, command: string, args: string[]): Promise<void> {
  if (command === 'sessions') {
    print(await grove.raw.request('debug.nvim.sessions'))
    return
  }
  if (command === 'windows') {
    print(await grove.raw.request('debug.nvim.windows', { session: args[0] }))
    return
  }
  if (command === 'lua') {
    if (!args[0]) throw new Error('usage: grove-debug lua <code> [session]')
    // The session only has to be named when more than one editor is open.
    print(await grove.raw.request('debug.nvim.lua', { code: args[0], session: args[1] }))
    return
  }
  if (command === 'rpc') {
    if (!args[0]) throw new Error('usage: grove-debug rpc <method> [jsonArgs]')
    const rpcArgs = args[1] ? JSON.parse(args[1]) : []
    print(await grove.raw.request('debug.nvim.request', { method: args[0], args: rpcArgs }))
    return
  }
  if (command === 'eval') {
    if (!args[0]) throw new Error('usage: grove-debug eval <expression>')
    print(await grove.raw.request('debug.renderer.eval', { expression: args[0] }))
    return
  }
  if (command === 'state') {
    print(await grove.raw.request('debug.renderer.eval', { expression: REVIEW_STATE_EXPRESSION }))
    return
  }
  if (command === 'scenario') {
    const scenario = SCENARIOS.find((entry) => entry.name === args[0])
    if (!scenario) {
      throw new Error(`unknown scenario: ${args[0]} (try "grove-debug scenarios")`)
    }
    await scenario.run(grove, args.slice(1))
    return
  }
  if (command === 'harnesses') {
    await runHarnessCommand(grove, args)
    return
  }
  if (command === 'agent') {
    await runAgentCommand(grove, args)
    return
  }
  if (command === 'review') {
    await runReviewCommand(grove, args)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

/** The mounted agent harnesses: which are there, and which can actually run. */
async function runHarnessCommand(grove: GroveClient, args: string[]): Promise<void> {
  const [sub = 'list'] = args
  if (sub === 'list') {
    print(await evaluate(grove, 'window.workbench.agents.harnesses()'))
    return
  }
  if (sub === 'catalog') {
    const harness = args[1]
    if (!harness) throw new Error('usage: harnesses catalog <harness>')
    print(await evaluate(grove, `window.workbench.agents.catalog(${JSON.stringify(harness)})`))
    return
  }
  throw new Error(`unknown harnesses command: ${sub}`)
}

async function runAgentCommand(grove: GroveClient, args: string[]): Promise<void> {
  const [sub, ...rest] = args

  /** The worktree every agent command targets: whatever the UI has selected. */
  async function targetWorktree(): Promise<string> {
    const worktreePath = await agent.selectedWorktree(grove)
    if (!worktreePath) throw new Error('no worktree selected — open a repo first')
    return worktreePath
  }

  /** The permission the command names, or the first one waiting. */
  async function namedPermission(id: string | undefined): Promise<agent.PendingPermission> {
    const pending = await agent.pendingPermissions(grove)
    const request = id ? pending.find((entry) => entry.id === id) : pending[0]
    if (!request) throw new Error('no pending permission')
    return request
  }

  if (sub === 'sessions') {
    print(await agent.sessions(grove, await targetWorktree()))
    return
  }
  if (sub === 'start') {
    if (!rest[0]) throw new Error('usage: grove-debug agent start <prompt>')
    const worktreePath = await targetWorktree()
    print(await agent.start(grove, { worktreePath, prompt: rest[0], mode: 'default' }))
    return
  }
  if (sub === 'send') {
    if (!rest[0]) throw new Error('usage: grove-debug agent send <text>')
    const worktreePath = await targetWorktree()
    print(await agent.send(grove, { worktreePath, text: rest[0] }))
    return
  }
  if (sub === 'stop') {
    const sessions = await agent.sessions(grove, await targetWorktree())
    const sessionId = rest[0] ?? sessions[0]?.id
    if (!sessionId) throw new Error('no session to stop')
    print(await agent.stop(grove, sessionId))
    return
  }
  if (sub === 'permissions') {
    print(await agent.pendingPermissions(grove))
    return
  }
  if (sub === 'allow') {
    print(
      await agent.respondPermission(grove, await namedPermission(rest[0]), { behavior: 'allow' })
    )
    return
  }
  if (sub === 'deny') {
    print(
      await agent.respondPermission(grove, await namedPermission(rest[1]), {
        behavior: 'deny',
        message: rest[0] ?? 'Denied by the debug harness'
      })
    )
    return
  }
  throw new Error(`unknown agent command: ${sub}`)
}

async function runReviewCommand(grove: GroveClient, args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'list') {
    print(await agent.queuedReviews(grove))
    return
  }
  if (sub === 'open') {
    const queued = await agent.queuedReviews(grove)
    const id = rest[0] ?? queued[0]?.id
    if (!id) throw new Error('no review queued')
    await agent.openReview(grove, id)
    print(await windows(grove))
    return
  }
  if (sub === 'decide') {
    if (rest.length < 3) {
      throw new Error('usage: grove-debug review decide <relPath> <hunkIndex> <accepted|rejected>')
    }
    const status = rest[2] as 'accepted' | 'rejected'
    print(await agent.decideHunk(grove, rest[0], Number(rest[1]), status))
    return
  }
  if (sub === 'comment') {
    if (rest.length < 3) {
      throw new Error('usage: grove-debug review comment <relPath> <hunkIndex> <text>')
    }
    print(await agent.commentHunk(grove, rest[0], Number(rest[1]), rest[2]))
    return
  }
  if (sub === 'finish') {
    print(await agent.finishReview(grove))
    return
  }
  throw new Error(`unknown review command: ${sub}`)
}

async function connect(): Promise<GroveClient> {
  const grove = await connectGrove({
    appId: 'grove-debug',
    name: 'Grove Debug Harness',
    version: '1.0.0',
    scopes: ['debug.all', 'workspace.read', 'git.read', 'editor.read', 'agents.read']
  })
  if (!grove.grantedScopes.includes('debug.all')) {
    grove.close()
    throw new Error('debug.all was not granted — start Grove with GROVE_DEBUG=1')
  }
  return grove
}

// A snapshot of everything the review feature depends on, in one call. The
// renderer exposes its stores on window under GROVE_DEBUG (see main.ts).
const REVIEW_STATE_EXPRESSION = `(() => {
  const debug = window.__grove_debug
  if (!debug) return { error: 'renderer debug hooks missing — is GROVE_DEBUG set?' }
  const { review, store, keymap, layout, agentSessions, agentTranscript } = debug
  return {
    activeBatch: review.active && {
      id: review.active.id,
      origin: review.active.origin,
      files: review.active.files.map((file) => ({
        relPath: file.relPath,
        hunks: file.hunks.length,
        deleted: file.deleted === true
      }))
    },
    activeFileIndex: review.activeFileIndex,
    leafOwner: review.leafOwner,
    queue: review.queue.map((batch) => ({ id: batch.id, origin: batch.origin })),
    pendingPermissions: Object.keys(agentSessions.live).flatMap((sessionId) =>
      agentTranscript.pendingApprovals(agentSessions.live[sessionId].transcript).map((item) => ({
        id: item.toolUseId,
        sessionId,
        toolName: item.name
      }))
    ),
    agentSessions: agentSessions.list.map((session) => ({
      id: session.id,
      workspaceRoot: session.workspaceRoot,
      status: session.status
    })),
    activeTabPath: store.activeTabPath,
    activePane: keymap.activePane,
    activeLeafId: keymap.activeLeafId,
    panes: layout.leafSummary ? layout.leafSummary() : undefined,
    error: store.error
  }
})()`

function usage(): void {
  console.log(`grove-debug — inspect and drive a running Grove (needs GROVE_DEBUG=1)

  sessions                 list live nvim sessions
  windows [session]        every tab/window with its buffer and diff state
  lua <code>               run lua in the editor; the code must return a value
  rpc <method> [jsonArgs]  raw nvim msgpack-rpc call
  eval <expression>        evaluate an expression in the renderer
  state                    snapshot of the review/editor state in one call
  scenarios                list replayable scenarios
  scenario <name> [args]   run one

  harnesses list                     mounted agent harnesses and whether they can run
  harnesses catalog <harness>        its models, commands and skills

  agent sessions                     agent sessions in the selected worktree
  agent start <prompt>               start a run in a new session, manual review
  agent send <text>                  send into the worktree's active session
  agent stop [sessionId]             interrupt the turn in flight
  agent permissions                  pending tool-permission requests
  agent allow [id]                   approve one (defaults to the first)
  agent deny <message> [id]          deny one

  review list                        queued review batches
  review open [batchId]              open one and dump nvim's windows
  review decide <path> <hunk> <verdict>
  review comment <path> <hunk> <text>
  review finish                      apply verdicts and report to the agent`)
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
})
