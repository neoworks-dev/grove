// Edit-menu actions (undo, copy, …) routed to whatever holds the keyboard: the
// focused editor runs them through nvim, a text field through the browser's own
// editing commands. The menu keeps focus where it was, so the focused element
// at click time is the one the user meant.

import { activeNvimSession, allNvimSessions } from './nvim/registry'

export type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'find'

// The browser command for each action a plain text field can run; find has none.
const FIELD_COMMANDS: Partial<Record<EditAction, string>> = {
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll'
}

/** Runs an Edit-menu action in the focused editor or text field. */
export function runEditAction(action: EditAction): void {
  const focusedEditor = allNvimSessions().find((session) => session.ownsKeyboard())
  if (focusedEditor) {
    void focusedEditor.runEditAction(action)
    return
  }
  if (focusedTextField()) {
    runInTextField(action)
    return
  }
  // Focus is on no text surface at all (a tree, a button): the editor the user
  // was last in is the most likely target.
  const editor = activeNvimSession()
  if (editor) {
    void editor.runEditAction(action)
  }
}

/** The focused input, textarea or contenteditable element, if focus is on one. */
function focusedTextField(): HTMLElement | null {
  const element = document.activeElement
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return element
  }
  return null
}

/** Runs an action on the focused text field through the browser's editing commands. */
function runInTextField(action: EditAction): void {
  const command = FIELD_COMMANDS[action]
  if (!command) {
    return
  }
  document.execCommand(command)
}
