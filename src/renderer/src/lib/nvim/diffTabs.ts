// How a diff tab rebuilds its diff when it is shown again. Neovim's diff is a
// window beside the tab's buffer, not part of the buffer: leaving the tab
// closes that window (or leaves it beside some other file), so coming back
// would show one side alone. Whatever opened the diff registers how to put the
// other side back, and the editor pane calls it each time it shows the tab.

import { store } from '../store.svelte'

type Restore = (nvimId: string) => Promise<void>

const restorers = new Map<string, Restore>()

// Before another tab is shown: move off the base side if the cursor is on it,
// so the tab opens in the file's own window; and when the next tab is not a
// diff, close every base window and end diff mode. A revision diff tears
// itself down on leaving, but a pull request's base window stays until the
// next file replaces it, so nothing can rely on that.
const LEAVE_LUA = `
local keep = ...

local function is_base(win)
  if vim.w[win].grove_revision_base then return true end
  return vim.b[vim.api.nvim_win_get_buf(win)].grove_pr_base == true
end

local bases = {}
local others = {}
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if is_base(win) then table.insert(bases, win) else table.insert(others, win) end
end

if is_base(vim.api.nvim_get_current_win()) and others[1] then
  vim.api.nvim_set_current_win(others[1])
end

if not keep then
  for _, win in ipairs(bases) do pcall(vim.api.nvim_win_close, win, true) end
  pcall(vim.cmd, 'diffoff!')
end
return true
`

/**
 * Readies the editor to show the tab at `nextPath`: out of any diff's base
 * window, and out of diff mode altogether unless the tab is a diff too. The
 * label decides, not a registered restore: a diff being opened has its label
 * before its diff is drawn, and tearing down here would race the drawing.
 */
export async function leaveDiff(nvimId: string, nextPath: string): Promise<void> {
  const keep = isDiffTab(nextPath)
  await window.workbench.nvim.request(nvimId, 'nvim_exec_lua', [LEAVE_LUA, [keep]])
}

/** Remembers how to rebuild the diff for the tab at this path. */
export function registerDiffRestore(path: string, restore: Restore): void {
  restorers.set(path, restore)
}

/**
 * Rebuilds the tab's diff, if it was opened as one and still is. A tab since
 * opened plainly, or closed, has lost its diff label and is forgotten here.
 */
export async function restoreDiff(nvimId: string, path: string): Promise<void> {
  const restore = restorers.get(path)
  if (!restore) return
  if (!isDiffTab(path)) {
    restorers.delete(path)
    return
  }
  await restore(nvimId)
}

/** Whether an open tab at this path is labelled as a diff. */
function isDiffTab(path: string): boolean {
  return store.tabs.some((tab) => tab.path === path && tab.diff !== undefined)
}
