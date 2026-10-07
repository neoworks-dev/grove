-- How windows and tab pages behave inside a grove pane: no tab pages, splits
-- evened out on resize, and q closing non-file views.

-- Grove shows no tab pages ('showtabline' is 0): its tab strip already is the
-- list of open files. A tab page would take windows somewhere only gt reaches,
-- so none are made. <C-w>T, which moves the current split to a tab page of its
-- own, keeps it as the only window instead; the other files stay in the strip.
vim.keymap.set("n", "<C-w>T", "<Cmd>only<CR>", { desc = "Keep only this split" })

-- Any other new tab page (:tabnew, :tabedit, :tab split, a plugin) is closed
-- again once the command is done, and its buffer shown in the window it was
-- opened from, where it becomes the active tab in the strip. An empty :tabnew
-- leaves the window as it was and its empty buffer is dropped.
local function grove_fold_tab_page()
  if #vim.api.nvim_list_tabpages() < 2 then
    return
  end
  local buffer = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local named = vim.api.nvim_buf_get_name(buffer) ~= ""
  vim.cmd("tabclose")
  if not named then
    if not vim.bo[buffer].modified then
      pcall(vim.api.nvim_buf_delete, buffer, {})
    end
    return
  end
  vim.api.nvim_win_set_buf(0, buffer)
  pcall(vim.api.nvim_win_set_cursor, 0, cursor)
end
vim.api.nvim_create_autocmd("TabNew", {
  callback = function()
    vim.schedule(grove_fold_tab_page)
  end,
})

-- nvim hands every column a resize adds to the current window, so splits end
-- up 13 columns against 161 once the pane grows. Even them out on every resize,
-- as LazyVim does; windows with winfixwidth/winfixheight keep their size.
vim.api.nvim_create_autocmd("VimResized", {
  callback = function()
    local current = vim.fn.tabpagenr()
    vim.cmd("tabdo wincmd =")
    vim.cmd("tabnext " .. current)
  end,
})

-- LazyVim's habit: q closes a split that shows something other than a file —
-- git blame, help, quickfix, checkhealth, any plugin's nofile view — unless
-- its plugin already uses q. Decided by buftype, not a filetype list, so a
-- plugin grove doesn't know about gets it too. acwrite is left out: grove's
-- scratch and review buffers are written like files and edited as such.
local grove_view_buftypes = { nofile = true, nowrite = true, help = true, quickfix = true }

local function grove_map_close_with_q()
  if not grove_view_buftypes[vim.bo.buftype] then
    return
  end
  if vim.fn.maparg("q", "n", false, true).buffer == 1 then
    return
  end
  -- pcall: the last window can't be closed (E444), and q then does nothing.
  vim.keymap.set("n", "q", function()
    pcall(vim.cmd.close)
  end, { buffer = true, silent = true, desc = "Close window" })
end

vim.api.nvim_create_autocmd({ "BufWinEnter", "FileType" }, {
  callback = grove_map_close_with_q,
})
