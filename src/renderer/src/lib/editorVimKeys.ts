// The editor's Vim normal-mode LSP keys. These are handled by the CodeMirror
// Vim adapter (not the keymap registry), so this list is the single source of
// truth used both to register them (EditorPane) and to document them in the
// keybinding cheatsheet.

export interface VimLspKey {
  keys: string
  // Vim action name registered via Vim.defineAction.
  action: string
  description: string
}

export const VIM_LSP_KEYS: VimLspKey[] = [
  { keys: 'gd', action: 'groveLspDefinition', description: 'Go to definition' },
  { keys: 'gr', action: 'groveLspReferences', description: 'Go to references' },
  { keys: 'gI', action: 'groveLspImplementation', description: 'Go to implementation' },
  { keys: 'gy', action: 'groveLspTypeDefinition', description: 'Go to type definition' },
  { keys: 'gD', action: 'groveLspDeclaration', description: 'Go to declaration' },
  { keys: 'K', action: 'groveLspHover', description: 'Hover / type info' },
  { keys: ']d', action: 'groveLspNextDiag', description: 'Next diagnostic' },
  { keys: '[d', action: 'groveLspPrevDiag', description: 'Previous diagnostic' },
  { keys: ']e', action: 'groveLspNextError', description: 'Next error' },
  { keys: '[e', action: 'groveLspPrevError', description: 'Previous error' }
]
