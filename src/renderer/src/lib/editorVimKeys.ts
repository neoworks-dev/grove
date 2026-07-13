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

// Which-key hints shown while a Vim operator is pending (keyed by the
// operator key). These document CodeMirror-Vim's built-in motions/text
// objects; the adapter handles the keys itself, this is display only.
export const VIM_OPERATOR_HINTS: Record<
  string,
  { title: string; entries: { keys: string; description: string }[] }
> = {
  d: {
    title: 'Delete',
    entries: [
      { keys: 'd', description: 'Line' },
      { keys: 'w', description: 'Next word' },
      { keys: 'b', description: 'Prev word' },
      { keys: 'e', description: 'Next end of word' },
      { keys: 'iw', description: 'Inside word' },
      { keys: 'aw', description: 'Around word' },
      { keys: 'i(', description: 'Inside brackets' },
      { keys: 'i"', description: 'Inside quotes' },
      { keys: '$', description: 'To end of line' },
      { keys: '0', description: 'To start of line' },
      { keys: '^', description: 'To first non-blank' },
      { keys: 'gg', description: 'To start of file' },
      { keys: 'G', description: 'To end of file' },
      { keys: 'f·', description: 'Through next char' },
      { keys: 't·', description: 'Until next char' },
      { keys: '{', description: 'Prev empty line' },
      { keys: '}', description: 'Next empty line' },
      { keys: '%', description: 'Matching bracket' },
      { keys: '/', description: 'Until search' }
    ]
  }
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
