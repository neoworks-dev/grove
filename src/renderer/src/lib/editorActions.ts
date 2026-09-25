// Registers the editor leader actions (editorActionTable.ts) as Grove bindings
// on editor panes, each running its Lua in the focused nvim session.

import { keymap } from './keymap.svelte'
import { dialogs } from './dialogs.svelte'
import { activeNvimSession } from './nvim/registry'
import { EDITOR_ACTIONS, luaCommandKeys, type EditorAction } from './editorActionTable'

/** Runs a Lua statement in the focused editor, in the mode the user is in. */
function runLua(lua: string): void {
  const id = activeNvimSession()?.id
  if (!id) {
    return
  }
  void window.workbench.nvim.input(id, luaCommandKeys(lua))
}

/** Flips a toggle in the focused editor and reports which way it went. */
async function runToggle(action: EditorAction, expression: string): Promise<void> {
  const id = activeNvimSession()?.id
  if (!id) {
    return
  }
  const enabled = await window.workbench.nvim
    .request(id, 'nvim_exec_lua', [`return ${expression}`, []])
    .catch(() => null)
  if (typeof enabled !== 'boolean') {
    return
  }
  const label = action.description.replace(/^Toggle /, '')
  let state = 'off'
  if (enabled) {
    state = 'on'
  }
  dialogs.notify({ level: 'info', message: `${label[0].toUpperCase()}${label.slice(1)} ${state}` })
}

/** What pressing the action's keys does. */
function actionRunner(action: EditorAction): () => void {
  const toggle = action.toggle
  if (toggle !== undefined) {
    return () => void runToggle(action, toggle)
  }
  const lua = action.lua
  if (lua !== undefined) {
    return () => runLua(lua)
  }
  return () => {}
}

/** Register the editor leader actions; returns the inverse. */
export function registerEditorActions(): () => void {
  return keymap.registerBindings(
    EDITOR_ACTIONS.map((action) => ({
      id: action.id,
      keys: action.keys,
      context: 'editor',
      group: action.group,
      description: action.description,
      run: actionRunner(action)
    }))
  )
}
