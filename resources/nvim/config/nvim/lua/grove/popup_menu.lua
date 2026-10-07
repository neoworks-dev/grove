-- The right-click menu: handing nvim's PopUp entries to grove, the entries
-- grove adds (Inspect, Fix with Agent), and running the one picked.

-- Right-click menu. nvim would draw its PopUp menu as grid cells, which grove
-- renders but cannot make clickable, so right-click instead does what
-- 'mousemodel' popup_setpos does to the cursor, lets the MenuPopup autocmds
-- enable the entries that apply here, and hands the entries to grove to show
-- as a real menu. Grove answers with grove_run_popup_item.

-- The PopUp menu's mode for the current mode: visual, insert or normal.
local function popup_mode()
  local mode = vim.fn.mode()
  if mode:match("^[vV\22sS\19]") then
    return "v"
  end
  if mode == "i" then
    return "i"
  end
  return "n"
end

-- True when a mouse position falls inside the current visual selection.
local function inside_selection(mouse)
  local start_line = vim.fn.line("v")
  local end_line = vim.fn.line(".")
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end
  return mouse.line >= start_line and mouse.line <= end_line
end

-- Move the cursor to the clicked cell, leaving a visual selection alone when
-- the click lands inside it so its Cut/Copy entries act on it.
local function place_cursor_at_mouse(mouse, mode)
  if mouse.winid == 0 or mouse.line == 0 then
    return mode
  end
  if mode == "v" and inside_selection(mouse) then
    return mode
  end
  if mode == "v" then
    vim.cmd("normal! \27")
    mode = "n"
  end
  vim.api.nvim_set_current_win(mouse.winid)
  pcall(vim.api.nvim_win_set_cursor, mouse.winid, { mouse.line, math.max(0, mouse.column - 1) })
  return mode
end

-- The PopUp entries for a mode, in menu order. A separator is `{ separator = true }`.
local function popup_items(mode)
  local items = {}
  for _, name in ipairs(vim.fn.menu_info("PopUp", mode).submenus or {}) do
    local entry = vim.fn.menu_info("PopUp." .. name, mode)
    if name:match("^%-.*%-$") then
      items[#items + 1] = { separator = true }
    elseif entry.rhs ~= nil and entry.rhs ~= "" then
      items[#items + 1] = { name = name, enabled = entry.enabled ~= false and entry.enabled ~= 0 }
    end
  end
  return items
end

local function grove_right_click()
  -- In the gutter, a right-click edits that line's breakpoint instead.
  if _G.grove_debug and _G.grove_debug.gutter_right_click() then
    return
  end
  local mode = place_cursor_at_mouse(vim.fn.getmousepos(), popup_mode())
  vim.api.nvim_exec_autocmds("MenuPopup", { pattern = mode, modeline = false })
  vim.rpcnotify(0, "grove_popup_menu", { mode = mode, items = popup_items(mode) })
end

vim.keymap.set({ "n", "x", "i" }, "<RightMouse>", grove_right_click, { desc = "Right-click menu" })
-- The release would otherwise extend a selection to wherever the pointer is.
vim.keymap.set({ "n", "x", "i" }, "<RightRelease>", "<Nop>")

-- :Inspect echoes its report, several lines long, so nvim stops on its
-- hit-enter prompt to show it. The menu's Inspect opens the same report as a
-- float at the cursor instead, gone when the cursor moves.
local function grove_inspect_float()
  local report = vim.api.nvim_exec2("Inspect", { output = true }).output
  local lines = vim.split(report, "\n", { trimempty = true })
  if #lines == 0 then
    return
  end
  vim.lsp.util.open_floating_preview(lines, "", { focus_id = "grove_inspect" })
end
vim.api.nvim_create_user_command("GroveInspect", grove_inspect_float, { desc = "Inspect in a float" })

-- nvim's MenuPopup autocmd only enables and disables entries, so redefining
-- this one sticks.
vim.cmd([[anoremenu PopUp.Inspect <Cmd>GroveInspect<CR>]])

-- Fix with Agent: on a line with diagnostics, the right-click menu hands them
-- to an agent. Grove lists the entry once per agent it could go to and reads
-- the problem through grove_fix_context; run from nvim's own :emenu, it goes to
-- grove as grove_fix_with_agent, for the worktree's agent.

-- The cursor line's diagnostics and the code `radius` lines either side of it,
-- or nil when the line has none.
_G.grove_fix_context = function(radius)
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1] - 1
  local found = vim.diagnostic.get(bufnr, { lnum = line })
  if #found == 0 then
    return nil
  end
  local diagnostics = {}
  for _, d in ipairs(found) do
    diagnostics[#diagnostics + 1] = {
      lnum = d.lnum,
      col = d.col,
      severity = d.severity,
      message = d.message,
      source = d.source,
    }
  end
  local first = math.max(0, line - radius)
  local last = math.min(vim.api.nvim_buf_line_count(bufnr), line + radius + 1)
  return {
    path = vim.api.nvim_buf_get_name(bufnr),
    diagnostics = diagnostics,
    startLine = first + 1,
    endLine = last,
    text = table.concat(vim.api.nvim_buf_get_lines(bufnr, first, last, false), "\n"),
  }
end

_G.grove_fix_with_agent = function()
  local context = grove_fix_context(10)
  if context == nil then
    return
  end
  vim.rpcnotify(0, "grove_fix_with_agent", context)
end

-- First in the menu: on a line with a problem, fixing it is the likeliest ask.
vim.cmd([[anoremenu .400 PopUp.Fix\ with\ Agent <Cmd>lua grove_fix_with_agent()<CR>]])
vim.cmd([[anoremenu .401 PopUp.-fix- <Nop>]])
vim.api.nvim_create_autocmd("MenuPopup", {
  group = vim.api.nvim_create_augroup("grove.fix_with_agent", {}),
  desc = "Offer Fix with Agent on lines with diagnostics",
  callback = function()
    local line = vim.api.nvim_win_get_cursor(0)[1] - 1
    if #vim.diagnostic.get(0, { lnum = line }) > 0 then
      vim.cmd([[anoremenu enable PopUp.Fix\ with\ Agent]])
      return
    end
    vim.cmd([[anoremenu disable PopUp.Fix\ with\ Agent]])
  end,
})

-- Each buffer's own snacks_scroll setting while a PopUp entry holds it off.
local grove_popup_scroll_setting = {}

-- Give a buffer its snacks.scroll setting back once a PopUp entry's keys are
-- done. Scheduled, so the WinScrolled the entry caused is seen while scrolling
-- is still off and the next scroll starts from where the entry left the view.
_G.grove_popup_item_done = function(buffer)
  vim.schedule(function()
    local setting = grove_popup_scroll_setting[buffer]
    grove_popup_scroll_setting[buffer] = nil
    if vim.api.nvim_buf_is_valid(buffer) then
      vim.b[buffer].snacks_scroll = setting
    end
  end)
end

-- Run the PopUp entry grove's menu picked, in the mode the menu was opened for.
-- snacks.scroll is held off while its keys run: it animates a jump by putting
-- the cursor back where it was and walking it over, so the V of Select All's
-- ggVG landed mid-walk and anchored the selection at the right-clicked line.
_G.grove_run_popup_item = function(name, mode)
  local entry = vim.fn.menu_info("PopUp." .. name, mode)
  if entry.rhs == nil or entry.rhs == "" then
    return
  end
  local keys = vim.api.nvim_replace_termcodes(entry.rhs, true, false, true)
  local flags = "m"
  if entry.noremenu then
    flags = "n"
  end
  local buffer = vim.api.nvim_get_current_buf()
  grove_popup_scroll_setting[buffer] = vim.b[buffer].snacks_scroll
  vim.b[buffer].snacks_scroll = false
  vim.api.nvim_feedkeys(keys, flags, false)
  local done = ("<Cmd>lua grove_popup_item_done(%d)<CR>"):format(buffer)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(done, true, false, true), "n", false)
end
