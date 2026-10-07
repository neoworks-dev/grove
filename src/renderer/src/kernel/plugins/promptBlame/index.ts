// Prompt blame in the editor: the cursor line an agent wrote shows the prompt
// that wrote it beside its commit, and <leader>gb adds it to the blame popup.
// nvim says which line it means; this asks main and answers back.

import type { Context } from '@neoworks/extension-system'
import { store } from '../../../lib/store.svelte'
import { blameLabel, blamePopupHeading, blamePopupLines } from '../../../lib/agents/blameLabel'
import type { LineBlame } from '../../../../../shared/agents'

/** The cursor line nvim reports, as its Lua sends it. */
interface BlameContext {
  buf: number
  path: string
  line: number
  text: string
}

export const promptBlame = {
  name: 'core/prompt-blame',

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        window.workbench.on('event:nvim-notify', (payload) => {
          const event = payload as { id: string; method: string; args: unknown[] }
          const context = contextOf(event.args)
          if (!context) return
          if (event.method === 'grove_line_blame') void showLineBlame(event.id, context)
          if (event.method === 'grove_line_blame_popup') void extendBlamePopup(event.id, context)
        }),
      'nvim:prompt-blame'
    )
  }
}

/** The context nvim sent, or null when it is not one. */
function contextOf(args: unknown[] | undefined): BlameContext | null {
  if (!args || args.length === 0) return null
  const context = args[0] as Partial<BlameContext> | null
  if (!context || typeof context.path !== 'string' || typeof context.line !== 'number') return null
  if (typeof context.text !== 'string' || typeof context.buf !== 'number') return null
  return context as BlameContext
}

/** Blames a line in the selected worktree; null for a file outside it. */
async function blame(context: BlameContext): Promise<LineBlame | null> {
  const worktree = store.selectedWorktree
  if (!worktree) return null
  if (!context.path.startsWith(`${worktree.path}/`)) return null
  try {
    return await window.workbench.blame.line(worktree.id, context.path, context.line, context.text)
  } catch {
    return null
  }
}

/** Puts the prompt that wrote the cursor line at its end, if an agent wrote it. */
async function showLineBlame(nvimId: string, context: BlameContext): Promise<void> {
  const result = await blame(context)
  if (!result) return
  const label = blameLabel(result)
  if (!label) return
  await window.workbench.nvim
    .request(nvimId, 'nvim_exec_lua', [
      'grove_show_prompt_blame(...)',
      [context.buf, context.line, context.text, label]
    ])
    .catch(() => {})
}

/**
 * Finishes the blame popup for the cursor line: the prompt that wrote it, if
 * an agent did, and the heading nvim uses when gitsigns opened no popup.
 */
async function extendBlamePopup(nvimId: string, context: BlameContext): Promise<void> {
  const result = await blame(context)
  if (!result) return
  await window.workbench.nvim
    .request(nvimId, 'nvim_exec_lua', [
      'grove_extend_blame_popup(...)',
      [context.buf, context.line, blamePopupHeading(result), blamePopupLines(result)]
    ])
    .catch(() => {})
}
