// The editing actions Grove offers on the space leader inside an editor pane:
// LSP, formatting, git hunks and UI toggles, laid out as LazyVim lays them out.
// They are ordinary Grove bindings (editorActions.ts registers them), so they
// are listed and rebindable in Keyboard Shortcuts; each one runs a line of Lua
// in the focused nvim. Kept as plain data so tests can check the layout.

export interface EditorAction {
  id: string
  keys: string
  // Which-key labels a prefix after its bindings' group, so every action under
  // one prefix shares a group.
  group: string
  description: string
  // A Lua statement run as `<Cmd>lua …<CR>`, i.e. in the mode the leader was
  // pressed in, so a code action from visual mode applies to the selection.
  lua?: string
  // A Lua expression returning the new state of a toggle; reported back as a
  // notification ("Spelling on").
  toggle?: string
}

export const EDITOR_ACTIONS: EditorAction[] = [
  // ── +code ───────────────────────────────────────────────────────
  {
    id: 'editor.codeAction',
    keys: '<Leader> c a',
    group: 'Code',
    description: 'Code action',
    lua: 'vim.lsp.buf.code_action()'
  },
  {
    id: 'editor.sourceAction',
    keys: '<Leader> c A',
    group: 'Code',
    description: 'Source action',
    lua: "vim.lsp.buf.code_action({ context = { only = { 'source' }, diagnostics = {} } })"
  },
  {
    id: 'editor.organizeImports',
    keys: '<Leader> c o',
    group: 'Code',
    description: 'Organize imports',
    lua: "vim.lsp.buf.code_action({ apply = true, context = { only = { 'source.organizeImports' }, diagnostics = {} } })"
  },
  {
    id: 'editor.rename',
    keys: '<Leader> c r',
    group: 'Code',
    description: 'Rename symbol',
    lua: 'vim.lsp.buf.rename()'
  },
  {
    id: 'editor.format',
    keys: '<Leader> c f',
    group: 'Code',
    description: 'Format',
    lua: "require('conform').format({ lsp_format = 'fallback' })"
  },
  {
    id: 'editor.codelensRun',
    keys: '<Leader> c c',
    group: 'Code',
    description: 'Run codelens',
    lua: 'vim.lsp.codelens.run()'
  },
  {
    id: 'editor.codelensRefresh',
    keys: '<Leader> c C',
    group: 'Code',
    description: 'Refresh and show codelens',
    lua: 'vim.lsp.codelens.refresh({ bufnr = 0 })'
  },
  {
    id: 'editor.lineDiagnostics',
    keys: '<Leader> c d',
    group: 'Code',
    description: 'Line diagnostics',
    lua: 'vim.diagnostic.open_float()'
  },
  {
    id: 'editor.lspInfo',
    keys: '<Leader> c l',
    group: 'Code',
    description: 'LSP info',
    lua: "vim.cmd('checkhealth vim.lsp')"
  },
  {
    id: 'editor.mason',
    keys: '<Leader> c m',
    group: 'Code',
    description: 'Mason',
    lua: "vim.cmd('Mason')"
  },

  // ── +git ────────────────────────────────────────────────────────
  {
    id: 'editor.git.blameLine',
    keys: '<Leader> g b',
    group: 'Git',
    description: 'Blame line',
    lua: "require('gitsigns').blame_line({ full = true })"
  },
  {
    id: 'editor.git.stageHunk',
    keys: '<Leader> g h s',
    group: 'Git',
    description: 'Stage hunk',
    lua: "require('gitsigns').stage_hunk()"
  },
  {
    id: 'editor.git.resetHunk',
    keys: '<Leader> g h r',
    group: 'Git',
    description: 'Reset hunk',
    lua: "require('gitsigns').reset_hunk()"
  },
  {
    id: 'editor.git.stageBuffer',
    keys: '<Leader> g h S',
    group: 'Git',
    description: 'Stage buffer',
    lua: "require('gitsigns').stage_buffer()"
  },
  {
    id: 'editor.git.resetBuffer',
    keys: '<Leader> g h R',
    group: 'Git',
    description: 'Reset buffer',
    lua: "require('gitsigns').reset_buffer()"
  },
  {
    id: 'editor.git.previewHunk',
    keys: '<Leader> g h p',
    group: 'Git',
    description: 'Preview hunk inline',
    lua: "require('gitsigns').preview_hunk_inline()"
  },
  {
    id: 'editor.git.blameBuffer',
    keys: '<Leader> g h B',
    group: 'Git',
    description: 'Blame buffer',
    lua: "require('gitsigns').blame()"
  },

  // ── +buffer ─────────────────────────────────────────────────────
  {
    id: 'editor.alternateBuffer',
    keys: '<Leader> b b',
    group: 'Buffer',
    description: 'Switch to other buffer',
    lua: "vim.cmd('buffer #')"
  },

  // ── +ui ─────────────────────────────────────────────────────────
  {
    id: 'editor.toggle.autoformat',
    keys: '<Leader> u f',
    group: 'UI',
    description: 'Toggle format on save',
    toggle: '(function() vim.g.grove_autoformat = vim.g.grove_autoformat == false; return vim.g.grove_autoformat end)()'
  },
  {
    id: 'editor.toggle.spelling',
    keys: '<Leader> u s',
    group: 'UI',
    description: 'Toggle spelling',
    toggle: '(function() vim.wo.spell = not vim.wo.spell; return vim.wo.spell end)()'
  },
  {
    id: 'editor.toggle.wrap',
    keys: '<Leader> u w',
    group: 'UI',
    description: 'Toggle line wrap',
    toggle: '(function() vim.wo.wrap = not vim.wo.wrap; return vim.wo.wrap end)()'
  },
  {
    id: 'editor.toggle.lineNumbers',
    keys: '<Leader> u l',
    group: 'UI',
    description: 'Toggle line numbers',
    toggle: '(function() vim.wo.number = not vim.wo.number; return vim.wo.number end)()'
  },
  {
    id: 'editor.toggle.relativeNumbers',
    keys: '<Leader> u L',
    group: 'UI',
    description: 'Toggle relative numbers',
    toggle: '(function() vim.wo.relativenumber = not vim.wo.relativenumber; return vim.wo.relativenumber end)()'
  },
  {
    id: 'editor.toggle.diagnostics',
    keys: '<Leader> u d',
    group: 'UI',
    description: 'Toggle diagnostics',
    toggle: '(function() vim.diagnostic.enable(not vim.diagnostic.is_enabled()); return vim.diagnostic.is_enabled() end)()'
  },
  {
    id: 'editor.toggle.inlayHints',
    keys: '<Leader> u h',
    group: 'UI',
    description: 'Toggle inlay hints',
    toggle: '(function() local on = not vim.lsp.inlay_hint.is_enabled({ bufnr = 0 }); vim.lsp.inlay_hint.enable(on, { bufnr = 0 }); return on end)()'
  }
]

/**
 * Turns a Lua statement into keys for nvim_input that run it without leaving
 * the current mode. nvim_input reads `<` as the start of a key name, so a
 * literal one is spelled `<lt>`.
 */
export function luaCommandKeys(lua: string): string {
  return `<Cmd>lua ${lua.replaceAll('<', '<lt>')}<CR>`
}
