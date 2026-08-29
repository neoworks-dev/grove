// Replayable debugging scenarios. Each drives a flow through the app's own code
// paths and reports what it observed, so a UI bug produces evidence instead of a
// description. Run via `bun scripts/grove-debug.ts scenario <name>`.

import type { GroveClient } from '../../sdk/src/client/node'
import { diffWindows, evaluate, lua, print, wait, windows } from './client'
import * as agent from './agent'

export interface Scenario {
  name: string
  describe: string
  run: (grove: GroveClient, args: string[]) => Promise<void>
}

// Reaches nvim and the renderer at all — run this first when nothing works.
const ping: Scenario = {
  name: 'ping',
  describe: 'confirm the harness reaches nvim and the renderer',
  run: async (grove) => {
    console.log(
      'nvim:',
      await lua(grove, 'return vim.version().major .. "." .. vim.version().minor')
    )
    console.log('renderer hooks:', await evaluate(grove, `typeof window.__grove_debug`))
    print('sessions', await grove.raw.request('debug.nvim.sessions'))
    const worktreePath = await agent.selectedWorktree(grove)
    console.log('worktree:', worktreePath)
    if (worktreePath) {
      print('agent sessions', await agent.sessions(grove, worktreePath))
    }
  }
}

// The core diagnostic: does the app's belief about the review match nvim?
const reviewState: Scenario = {
  name: 'review-state',
  describe: "compare the app's review state against nvim's actual windows",
  run: async (grove) => {
    const app = await evaluate(
      grove,
      `(() => {
        const { review, store, keymap, agentSessions, agentTranscript } = window.__grove_debug
        return {
          active: review.active && { id: review.active.id, origin: review.active.origin },
          activeFile: review.activeFile && review.activeFile.relPath,
          leafOwner: review.leafOwner,
          queued: review.queue.length,
          pendingPermissions: Object.values(agentSessions.live).reduce(
            (total, session) => total + agentTranscript.pendingApprovals(session.transcript).length,
            0
          ),
          activeTabPath: store.activeTabPath,
          activePane: keymap.activePane,
          error: store.error
        }
      })()`
    )
    print('app review state', app)

    const state = await windows(grove)
    print('nvim windows', state)

    const diffs = diffWindows(state)
    console.log(`\ndiff windows open: ${diffs.length}`)

    const { leafOwner } = app as { leafOwner?: string | null }
    if (leafOwner && diffs.length === 0) {
      console.log(
        '\nMISMATCH: the app believes a review is rendered (leafOwner set) but nvim has no\n' +
          'window in diff mode. Something replaced the diff buffers after they were built.'
      )
    }
    if (!leafOwner && diffs.length > 0) {
      console.log('\nMISMATCH: nvim holds a diff the app no longer tracks — a leaked review tab.')
    }
  }
}

// Distinguishes "never rendered" from "rendered, then destroyed" by sampling twice.
const reviewOpen: Scenario = {
  name: 'review-open',
  describe: 'open the first queued review and check the diff survives',
  run: async (grove) => {
    const queued = await agent.queuedReviews(grove)
    if (queued.length === 0) {
      console.log('no reviews queued — run `scenario review-e2e` or have the agent edit something')
      return
    }
    print('queued reviews', queued)

    await agent.openReview(grove, queued[0].id)

    await wait(300)
    const immediate = await windows(grove)
    print('windows just after open', immediate)

    await wait(1500)
    const settled = await windows(grove)

    const first = diffWindows(immediate).length
    const second = diffWindows(settled).length
    console.log(`\ndiff windows: ${first} immediately, ${second} after effects settle`)

    if (first > 0 && second === 0) {
      print('windows after settling', settled)
      console.log('The diff rendered and was then destroyed — a reactive effect edited over it.')
    } else if (first === 0) {
      console.log('The diff never rendered.')
      console.log('app error:', await agent.lastError(grove))
    } else {
      console.log('The diff rendered and held.')
    }
  }
}

// Isolates the lua from the app: if this renders, any failure in the real flow
// belongs to the app, not the lua.
const diffProbe: Scenario = {
  name: 'diff-probe',
  describe: "render a synthetic review diff through the app's own session method",
  run: async (grove) => {
    print('windows before', await windows(grove))

    const outcome = await evaluate(
      grove,
      `(async () => {
        const { nvimRegistry } = window.__grove_debug
        const session = nvimRegistry.anyNvimSession()
        if (!session) return { error: 'no editor session registered' }
        try {
          await session.openReviewDiff({
            path: '/tmp/grove-diff-probe.txt',
            baseline: 'alpha\\nbeta\\ngamma\\n',
            current: 'alpha\\nBETA\\ngamma\\ndelta\\n',
            sideBySide: true
          })
          return { ok: true, leafId: session.leafId }
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) }
        }
      })()`
    )
    print('openReviewDiff outcome', outcome)

    await wait(400)
    const after = await windows(grove)
    print('windows after', after)

    if (diffWindows(after).length >= 2) {
      console.log('\nThe lua works. Any failure in the real flow is the app, not the lua.')
    } else {
      console.log('\nThe lua itself produced no diff — the error above is the real cause.')
    }
  }
}

// Does following the active tab destroy an open review? This is the bug the
// NvimPane guard addresses; the scenario proves whether the guard holds.
const tabFollow: Scenario = {
  name: 'tab-follow',
  describe: 'check whether an active-tab change destroys an open review diff',
  run: async (grove) => {
    const before = await windows(grove)
    const beforeCount = diffWindows(before).length
    if (beforeCount === 0) {
      console.log('no diff open — run `scenario review-open` first, this needs one to clobber')
      return
    }
    console.log(`diff windows before: ${beforeCount}`)

    const touched = await evaluate(
      grove,
      `(() => {
        const { store } = window.__grove_debug
        const tabs = store.tabs
        if (tabs.length === 0) return null
        store.activeTabPath = tabs[0].path
        return store.activeTabPath
      })()`
    )
    console.log('set activeTabPath to:', touched)

    await wait(800)
    const after = diffWindows(await windows(grove)).length
    console.log(`diff windows after: ${after}`)
    if (beforeCount > 0 && after === 0) {
      console.log('\nCONFIRMED: following the active tab destroys the review diff.')
    } else {
      console.log('\nThe diff survived — the tab-follow guard is holding.')
    }
  }
}

// The whole gated-review flow, driven end to end: start an agent, let it ask to
// edit, review its change, reject a hunk, and confirm what landed on disk.
const reviewEndToEnd: Scenario = {
  name: 'review-e2e',
  describe: 'drive a full gated review: run an agent, review its edit, reject a hunk',
  run: async (grove, args) => {
    const worktreePath = args[0] ?? (await agent.selectedWorktree(grove))
    if (!worktreePath) throw new Error('no worktree selected — open a repo first')

    const prompt =
      args[1] ??
      'Create a file called debug-review-probe.txt containing exactly three lines: one, two, three. Then stop.'

    console.log(`worktree: ${worktreePath}\nprompt: ${prompt}\n`)
    print('started', await agent.start(grove, { worktreePath, prompt, mode: 'default' }))

    console.log('waiting for the agent to ask permission…')
    const permission = await agent.awaitPermission(grove)
    if (!permission) {
      console.log('no permission arrived within the timeout.')
      console.log('app error:', await agent.lastError(grove))
      return
    }
    print('permission', permission)

    console.log('waiting for the review to be raised…')
    const review = await agent.awaitReview(grove, 15_000)
    if (!review) {
      console.log('NO REVIEW was raised for this permission — the gated path did not fire.')
      console.log('app error:', await agent.lastError(grove))
      return
    }
    print('review', review)

    await agent.openReview(grove, review.id)
    await wait(1200)

    const state = await windows(grove)
    const diffs = diffWindows(state)
    console.log(`\ndiff windows after opening the review: ${diffs.length}`)
    if (diffs.length === 0) {
      print('windows', state)
      console.log('app error:', await agent.lastError(grove))
      console.log('\nThe review opened but rendered no diff — stop here, this is the bug.')
      return
    }
    print(
      'diff buffers',
      diffs.map((entry) => ({ name: entry.name, lines: entry.lines, modifiable: entry.modifiable }))
    )

    // Reject the first hunk with a comment, leaving any others accepted.
    const file = review.files[0]
    await agent.decideHunk(grove, file.relPath, 0, 'rejected')
    await agent.commentHunk(grove, file.relPath, 0, 'Rejected by the debug harness.')
    console.log(`\nrejected hunk 0 of ${file.relPath}`)

    await agent.finishReview(grove)
    await wait(1500)

    print('state after finishing', {
      queued: (await agent.queuedReviews(grove)).length,
      pendingPermissions: (await agent.pendingPermissions(grove)).length,
      error: await agent.lastError(grove)
    })
    console.log('\nCheck the file on disk: the rejected hunk should not be in it.')
  }
}

export const SCENARIOS: Scenario[] = [
  ping,
  reviewState,
  reviewOpen,
  diffProbe,
  tabFollow,
  reviewEndToEnd
]
