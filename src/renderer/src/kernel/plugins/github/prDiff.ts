// The Neovim side of reading a pull request: the merge base's copy of a file
// opened beside the file itself, in Neovim's own diff mode.
//
// The right-hand side is the real file in the checked-out worktree — not a copy
// of it — so it keeps its language server, its git signs and its editability.
// Only the left side is synthetic: a read-only scratch buffer marked
// `grove_pr_base`, which is how the next file replaces the previous one's window
// instead of stacking another split on it.

import { waitForNvimSession } from '../../../lib/nvim/registry'
import type { GithubPrFile } from '../../../../../shared/types'

// Close any base window left from the file before this one, then put the base
// copy to the left of the file and diff the two. The cursor ends on the real
// file at its first change: that is the side you edit, and the top of a file is
// rarely where the change is.
const DIFF_LUA = `
local args = ...

for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.b[buf].grove_pr_base then pcall(vim.api.nvim_win_close, win, true) end
end

pcall(function() vim.opt.diffopt:append('linematch:60') end)

local base = vim.api.nvim_create_buf(false, true)
vim.bo[base].buftype = 'nofile'
vim.bo[base].swapfile = false
vim.bo[base].bufhidden = 'wipe'
vim.api.nvim_buf_set_lines(base, 0, -1, false, args.lines)
pcall(vim.api.nvim_buf_set_name, base, args.name)
-- The buffer's own name ends in ' @ base', so the filetype is matched from the
-- real path instead. Neovim's own matcher, not a table kept here.
local filetype = vim.filetype.match({ filename = args.path })
if filetype then vim.bo[base].filetype = filetype end
vim.bo[base].modifiable = false
vim.b[base].grove_pr_base = true

vim.cmd('diffthis')
vim.cmd('leftabove vsplit')
vim.api.nvim_win_set_buf(0, base)
vim.cmd('diffthis')
vim.cmd('wincmd l')
vim.cmd('silent! normal! gg]c')
`

// A file the pull request deleted has no worktree copy to sit beside, so its
// base content is shown on its own rather than as half of a diff.
const BASE_ONLY_LUA = `
local args = ...

for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.b[buf].grove_pr_base then pcall(vim.api.nvim_win_close, win, true) end
end

local base = vim.api.nvim_create_buf(false, true)
vim.bo[base].buftype = 'nofile'
vim.bo[base].swapfile = false
vim.bo[base].bufhidden = 'wipe'
vim.api.nvim_buf_set_lines(base, 0, -1, false, args.lines)
pcall(vim.api.nvim_buf_set_name, base, args.name)
-- The buffer's own name ends in ' @ base', so the filetype is matched from the
-- real path instead. Neovim's own matcher, not a table kept here.
local filetype = vim.filetype.match({ filename = args.path })
if filetype then vim.bo[base].filetype = filetype end
vim.bo[base].modifiable = false
vim.b[base].grove_pr_base = true

vim.cmd('silent! diffoff')
vim.api.nvim_win_set_buf(0, base)
`

/** How long to wait for the editor to finish opening the file to diff against. */
const OPEN_TIMEOUT_MS = 4000

/** The arguments the Lua above reads, built from a file and its base content. */
function luaArgs(file: GithubPrFile, baseContent: string): Record<string, unknown> {
  return {
    name: `${file.oldPath || file.path} @ base`,
    path: file.oldPath || file.path,
    lines: baseContent.split('\n')
  }
}

/**
 * Wait for the editor to have this file open. `openFileInEditor` only writes the
 * tab; the pane pushes it to Neovim from an effect, so diffing immediately would
 * diff against whatever was open before.
 */
async function waitForFile(path: string): Promise<boolean> {
  const session = await waitForNvimSession()
  if (!session || !session.id) return false
  const deadline = performance.now() + OPEN_TIMEOUT_MS
  while (performance.now() < deadline) {
    const active = await session.getActiveFile()
    if (active && active.path.endsWith(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** Put the merge base's copy of a file beside the open file, in diff mode. */
export async function diffAgainstBase(file: GithubPrFile, baseContent: string): Promise<void> {
  const opened = await waitForFile(file.path)
  if (!opened) return
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    DIFF_LUA,
    [luaArgs(file, baseContent)]
  ])
}

/** Show a deleted file as the merge base had it, with nothing to diff against. */
export async function showPrBaseOnly(file: GithubPrFile, baseContent: string): Promise<void> {
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    BASE_ONLY_LUA,
    [luaArgs(file, baseContent)]
  ])
}
