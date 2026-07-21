// Reusable "scratch buffer" capability for the embedded editor. Opens an
// editable, non-file Neovim buffer that shows up as a specially-marked grove
// editor tab, applies its contents through a caller callback on `:w`, and — in
// this single-window editor — closes without taking the other buffers (or the
// pane) with it.
//
// The buffer carries only the minimal wiring:
//   • BufWriteCmd  → raises grove_scratch_write; the callback applies the edit.
//   • :q / :wq / :x → routed to a buffer close that switches back to the
//     previous buffer instead of quitting Neovim, then drops the grove tab.
// The buffer is bufhidden=wipe, so leaving it always discards it.

import { store } from '../store.svelte'
import { anyNvimSession } from './registry'

export interface ScratchEntry {
  key: string
  nvimId: string
  bufnr: number
  onWrite: (lines: string[]) => void | Promise<void>
}

export interface ScratchOptions {
  // Buffer name + tab label (e.g. '[rename]').
  title: string
  lines: string[]
  filetype?: string
  onWrite: (lines: string[]) => void | Promise<void>
}

const entries = new Map<string, ScratchEntry>()
let counter = 0
let started = false

// The scratch entry backing a grove tab path, if that tab is a scratch buffer.
// NvimPane uses this to switch the window to the buffer instead of :edit-ing.
export function scratchFor(path: string | null | undefined): ScratchEntry | undefined {
  if (!path) return undefined
  return entries.get(path)
}

// Subscribe once to the write/close notifications the scratch lua raises.
function start(): void {
  if (started) return
  started = true
  window.workbench.on('event:nvim-notify', (payload) => {
    const event = payload as { id: string; method: string; args: unknown[] }
    if (event.method === 'grove_scratch_write') {
      const data = (event.args?.[0] ?? {}) as { token?: string; lines?: unknown }
      const entry = data.token ? entries.get(data.token) : undefined
      if (entry && Array.isArray(data.lines)) void entry.onWrite(data.lines as string[])
      return
    }
    if (event.method === 'grove_scratch_close') {
      const data = (event.args?.[0] ?? {}) as { token?: string }
      if (data.token) closeScratch(data.token)
    }
  })
}

// Minimal nvim wiring for the buffer. Args: token, title, lines, filetype.
// Returns the created buffer number.
const SCRATCH_LUA = `
local token, title, lines, filetype = ...
local buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.bo[buf].buftype = 'acwrite'
vim.bo[buf].bufhidden = 'wipe'
vim.bo[buf].swapfile = false
if filetype ~= '' then vim.bo[buf].filetype = filetype end
vim.b[buf].grove_scratch_token = token
pcall(vim.api.nvim_buf_set_name, buf, title)

-- :w applies the edit but keeps the buffer open (unmodified) so it can iterate.
vim.api.nvim_create_autocmd('BufWriteCmd', {
  buffer = buf,
  callback = function()
    vim.rpcnotify(0, 'grove_scratch_write', {
      token = token,
      lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false),
    })
    vim.bo[buf].modified = false
  end,
})

-- Close = leave the buffer (never quit nvim). Switch the window back to the
-- alternate buffer so this single-window editor survives, then let grove drop
-- the tab. bufhidden=wipe discards the scratch once it's no longer shown.
local function leave(write)
  if write then
    vim.rpcnotify(0, 'grove_scratch_write', {
      token = token,
      lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false),
    })
  end
  vim.bo[buf].modified = false
  local alt = vim.fn.bufnr('#')
  if alt > 0 and alt ~= buf and vim.api.nvim_buf_is_valid(alt) then
    vim.api.nvim_set_current_buf(alt)
  end
  vim.rpcnotify(0, 'grove_scratch_close', { token = token })
end

-- bang is accepted but ignored (leaving already discards the buffer). :q!
-- needs no separate abbrev: typing '!' after 'q' triggers the 'q' expansion
-- while the cmdline is still 'q', yielding ':GroveScratchClose!'.
vim.api.nvim_buf_create_user_command(buf, 'GroveScratchClose', function(opts)
  leave(opts.args == 'write')
end, { nargs = '?', bang = true })

-- Route the common quit commands (exact match only) to the buffer close.
local function route(lhs, rhs)
  vim.cmd(string.format(
    "cnoreabbrev <buffer> <expr> %s (getcmdtype() ==# ':' && getcmdline() ==# '%s') ? '%s' : '%s'",
    lhs, lhs, rhs, lhs))
end
route('q', 'GroveScratchClose')
route('wq', 'GroveScratchClose write')
route('x', 'GroveScratchClose write')

vim.api.nvim_set_current_buf(buf)
return buf
`

// Open a scratch buffer in the active editor and register it as a grove tab.
export async function openScratch(options: ScratchOptions): Promise<void> {
  start()
  const worktreeId = store.selectedWorktreeId
  if (!worktreeId) return
  const session = anyNvimSession()
  if (!session?.id) {
    store.setError('Open an editor pane first.')
    return
  }
  counter += 1
  const key = `scratch://${counter}/${options.title}`
  let bufnr: unknown
  try {
    bufnr = await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
      SCRATCH_LUA,
      [key, options.title, options.lines, options.filetype ?? '']
    ])
  } catch (err) {
    store.setError((err as Error).message)
    return
  }
  if (typeof bufnr !== 'number') {
    store.setError('Failed to open scratch buffer.')
    return
  }
  entries.set(key, { key, nvimId: session.id, bufnr, onWrite: options.onWrite })
  store.openTab({ worktreeId, path: key, name: options.title, scratch: true })
  session.focus()
}

// Remove a scratch buffer: drop the registry entry and the grove tab, and wipe
// the nvim buffer (best-effort — the :q path may have wiped it already).
export function closeScratch(key: string): void {
  const entry = entries.get(key)
  entries.delete(key)
  store.closeTab(key)
  if (entry) {
    void window.workbench.nvim
      .request(entry.nvimId, 'nvim_buf_delete', [entry.bufnr, { force: true }])
      .catch(() => {})
  }
}
