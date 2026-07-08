// Actions a keybinding can trigger beyond built-in commands. Custom bindings
// are stored in the settings provider under the reserved 'keybindings.custom'
// key and materialized into live bindings by the keymap.

export type KeybindAction =
  | { type: 'command'; commandId: string }
  // Runs in the active worktree via the main process; supports the same
  // ${PORT_n}/$WT_* substitutions as configured services.
  | { type: 'shell'; commandLine: string }
  // Prefills (or auto-sends) a prompt to the agent pane.
  | { type: 'ai-prompt'; prompt: string; autoSend: boolean; agent?: string }

export interface CustomBinding {
  // 'custom.<unique>' — namespaced so overrides can never collide with
  // registered binding ids.
  id: string
  // Canonical key sequence (see renderer keySequence grammar).
  keys: string
  description: string
  // 'global' or a pane context; matches KeyBinding.context semantics.
  context?: string
  action: KeybindAction
}
