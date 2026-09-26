// The core half of what agents can put on screen: marked lines, diffs and
// panes. Features with targets of their own (the GitHub pane's issues) register
// theirs beside these.

import { layout } from '../../../lib/layout.svelte'
import { panes } from '../../../lib/panes.svelte'
import { markLinesInEditor } from '../../../lib/store.svelte'
import { openWorkingTreeDiff } from '../../../lib/nvim/revisionDiff'
import { absoluteIn, registerShowHandler, relativeIn } from '../../../lib/agents/show'

/** Registers the core show handlers; returns their unregister. */
export function registerCoreShowHandlers(): () => void {
  const disposers = [
    registerShowHandler('code', (worktree, target) => {
      markLinesInEditor(worktree.id, absoluteIn(worktree, target.path), {
        startLine: target.startLine,
        endLine: target.endLine,
        note: target.note
      })
    }),
    registerShowHandler('diff', async (worktree, target) => {
      if (!target.path) {
        layout.ensurePane('changes')
        return
      }
      await openWorkingTreeDiff({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        path: relativeIn(worktree, target.path),
        revision: 'HEAD',
        label: 'HEAD',
        deleted: false
      })
    }),
    registerShowHandler('pane', (_worktree, target) => {
      layout.ensurePane(target.pane)
    })
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Tell the main process which panes there are, whenever plugins register or
 * drop one, so `open_pane` offers exactly those.
 */
export function reportPaneTypes(): () => void {
  return $effect.root(() => {
    $effect(() => {
      // Plain objects: a $state proxy cannot cross IPC.
      const types = panes.openableTypes().map((type) => ({ id: type.id, title: type.title }))
      void window.workbench.agents.setPaneTypes(types).catch(() => {})
    })
  })
}
