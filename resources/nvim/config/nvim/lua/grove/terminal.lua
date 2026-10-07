-- A dependency-free popup terminal for exercising (and using) Grove's native
-- multigrid float surface. The terminal buffer and shell process survive while
-- the window is hidden; invoking the command again reopens the same session.
-- This deliberately uses nvim_open_win rather than a terminal plugin so the
-- feature remains available when lazy.nvim could not install anything offline.
local grove_terminal = { buf = nil, win = nil }

local function grove_terminal_geometry()
  local columns = vim.o.columns
  local lines = vim.o.lines
  local width = math.max(20, math.min(columns - 4, math.floor(columns * 0.78)))
  local height = math.max(6, math.min(lines - 4, math.floor(lines * 0.68)))
  return {
    relative = "editor",
    row = math.floor((lines - height) / 2),
    col = math.floor((columns - width) / 2),
    width = width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = " Terminal ",
    title_pos = "center",
  }
end

local function grove_popup_terminal()
  if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
    pcall(vim.api.nvim_win_close, grove_terminal.win, true)
    grove_terminal.win = nil
    return
  end

  if not grove_terminal.buf or not vim.api.nvim_buf_is_valid(grove_terminal.buf) then
    grove_terminal.buf = vim.api.nvim_create_buf(false, true)
    vim.bo[grove_terminal.buf].bufhidden = "hide"
  end

  grove_terminal.win = vim.api.nvim_open_win(grove_terminal.buf, true, grove_terminal_geometry())
  vim.wo[grove_terminal.win].number = false
  vim.wo[grove_terminal.win].relativenumber = false
  vim.wo[grove_terminal.win].signcolumn = "no"

  if vim.bo[grove_terminal.buf].buftype ~= "terminal" then
    vim.api.nvim_buf_call(grove_terminal.buf, function()
      local shell = vim.env.SHELL
      if shell == nil or shell == "" then
        shell = vim.o.shell
      end
      if shell == nil or shell == "" then
        shell = "/bin/bash"
      end
      local cmd = vim.fn.has("win32") == 1 and shell or { shell, "-l", "-i" }
      local term_env = {
        XDG_CONFIG_HOME = vim.env.REAL_XDG_CONFIG_HOME or (vim.env.HOME .. "/.config"),
        XDG_DATA_HOME = vim.env.REAL_XDG_DATA_HOME or (vim.env.HOME .. "/.local/share"),
        XDG_STATE_HOME = vim.env.REAL_XDG_STATE_HOME or (vim.env.HOME .. "/.local/state"),
        XDG_CACHE_HOME = vim.env.REAL_XDG_CACHE_HOME or (vim.env.HOME .. "/.cache"),
      }
      vim.fn.termopen(cmd, {
        env = term_env,
        on_exit = function()
          if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
            pcall(vim.api.nvim_win_close, grove_terminal.win, true)
            grove_terminal.win = nil
          end
          if grove_terminal.buf and vim.api.nvim_buf_is_valid(grove_terminal.buf) then
            pcall(vim.api.nvim_buf_delete, grove_terminal.buf, { force = true })
            grove_terminal.buf = nil
          end
        end,
      })
    end)
    vim.keymap.set("t", "<Esc><Esc>", function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = "Close popup terminal" })
    vim.keymap.set("t", "<C-w>q", function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = "Close popup terminal" })
    vim.keymap.set("n", "q", function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = "Close popup terminal" })
  end
  vim.cmd("startinsert")
end

vim.api.nvim_create_autocmd("WinClosed", {
  callback = function(args)
    if grove_terminal.win and tonumber(args.match) == grove_terminal.win then
      grove_terminal.win = nil
    end
  end,
})

--- The window a buffer shown in the popup terminal belongs in: the one focused
--- before it when that is a normal window, otherwise the tab page's first.
local function grove_editor_window()
  local previous = vim.fn.win_getid(vim.fn.winnr("#"))
  if previous ~= 0 and vim.api.nvim_win_get_config(previous).relative == "" then
    return previous
  end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(win).relative == "" then
      return win
    end
  end
  return nil
end

-- Grove opens files, scratch buffers and diffs in the current window, which is
-- the popup terminal while it has focus. Anything else that lands there goes
-- to the editor window instead, which becomes current, and the terminal hides
-- (its shell lives on). This runs synchronously inside the open, so the RPC
-- calls Grove makes next (the diff split, a cursor jump) already act on the
-- editor window. Closing the float waits a tick: the window layout must not
-- change while the buffer is still being entered.
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function(args)
    local float = grove_terminal.win
    if not float or vim.api.nvim_get_current_win() ~= float then
      return
    end
    if args.buf == grove_terminal.buf then
      return
    end
    local editor = grove_editor_window()
    if not editor then
      return
    end
    vim.api.nvim_win_set_buf(editor, args.buf)
    vim.api.nvim_set_current_win(editor)
    pcall(vim.api.nvim_win_set_buf, float, grove_terminal.buf)
    vim.schedule(function()
      if vim.api.nvim_win_is_valid(float) then
        pcall(vim.api.nvim_win_close, float, true)
      end
    end)
  end,
})

vim.api.nvim_create_autocmd("VimResized", {
  callback = function()
    if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
      vim.api.nvim_win_set_config(grove_terminal.win, grove_terminal_geometry())
    end
  end,
})

vim.api.nvim_create_user_command("GroveTerminal", grove_popup_terminal, {
  desc = "Toggle a terminal in a native Grove floating surface",
})
vim.keymap.set("n", "<leader>tt", grove_popup_terminal, {
  desc = "Toggle popup terminal",
})
