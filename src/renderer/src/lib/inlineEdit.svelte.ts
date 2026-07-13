// Inline agent edit: bridge the editor selection to the agent. Phase A drops an
// @file:lines reference into the composer so the user can attach a prompt; later
// phases dispatch the edit and surface an accept/reject overlay over the change.

import { store, insertIntoComposer } from './store.svelte'
import { layout } from './layout.svelte'
import { activeNvimSession } from './nvim/registry'
import { relFromRoot, selectionRef } from './inlineEditRef'

// Read the active editor selection and drop its @file:lines reference into the
// agent composer, opening/focusing the agent panel so the user adds a prompt.
export async function sendSelectionToComposer(): Promise<void> {
  const session = activeNvimSession()
  if (!session) return
  const selection = await session.getVisualSelection()
  if (!selection || !selection.path) return
  const relPath = relFromRoot(store.selectedWorktree?.path, selection.path)
  const ref = selectionRef(relPath, selection.startLine, selection.endLine)
  layout.ensurePane('agent')
  insertIntoComposer(ref)
}
