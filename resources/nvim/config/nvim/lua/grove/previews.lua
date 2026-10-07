-- Previews nvim opens beside the cursor without entering (hover, line
-- diagnostics, Inspect) only close when the cursor moves. Escape in normal
-- mode closes them too, and clears the search highlight as LazyVim's does.
local function grove_close_previews()
  local current = vim.api.nvim_get_current_win()
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local config = vim.api.nvim_win_get_config(win)
    local preview = config.relative ~= "" and win ~= current and (config.zindex or 50) < 100
    if preview and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == "nofile" then
      pcall(vim.api.nvim_win_close, win, false)
    end
  end
end
vim.keymap.set("n", "<Esc>", function()
  grove_close_previews()
  vim.cmd.nohlsearch()
end, { desc = "Close previews and clear search highlight" })
