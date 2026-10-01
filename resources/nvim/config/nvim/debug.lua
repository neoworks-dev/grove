-- The debugger's marks in the editor. Grove's main process owns breakpoints
-- and debug sessions (src/main/debug); this file only draws them and reports
-- what happens in the buffer:
--
--   grove_debug.sync(state)          Grove pushes every breakpoint and the
--                                    stopped line; each loaded buffer redraws.
--   grove_debug_ready                sent once on load, so a new editor gets
--                                    the state without waiting for a change.
--   grove_debug_toggle_breakpoint    a click in the gutter.
--   grove_debug_breakpoints_moved    after a write, where each breakpoint's
--                                    mark ended up once lines above it changed.
--
-- Breakpoints are extmarks, so they ride along with edits the way the text
-- does; Grove only learns the new lines on write, which is when an adapter
-- would read the file anyway.

local M = {}

local namespace = vim.api.nvim_create_namespace('grove_debug')

-- Above gitsigns (6) and diagnostics (10): a breakpoint is the sign the user
-- placed, and the one they need to see.
local BREAKPOINT_PRIORITY = 50
local STOPPED_PRIORITY = 60

local SIGNS = {
  breakpoint = { text = '●', hl = 'GroveBreakpoint' },
  conditional = { text = '◆', hl = 'GroveBreakpoint' },
  log = { text = '◆', hl = 'GroveLogpoint' },
  unverified = { text = '○', hl = 'GroveBreakpointUnverified' },
  disabled = { text = '○', hl = 'GroveBreakpointDisabled' },
  stopped = { text = '▶', hl = 'GroveDebugStopped' }
}

-- Fallbacks until grove_apply_theme paints them in the app's palette.
local function define_default_highlights()
  local set = vim.api.nvim_set_hl
  set(0, 'GroveBreakpoint', { default = true, link = 'DiagnosticError' })
  set(0, 'GroveLogpoint', { default = true, link = 'DiagnosticInfo' })
  set(0, 'GroveBreakpointUnverified', { default = true, link = 'Comment' })
  set(0, 'GroveBreakpointDisabled', { default = true, link = 'Comment' })
  set(0, 'GroveDebugStopped', { default = true, link = 'DiagnosticWarn' })
  set(0, 'GroveDebugStoppedLine', { default = true, link = 'CursorLine' })
end

local state = { breakpoints = {}, stopped = vim.NIL, sessionActive = false }

-- Extmark id -> breakpoint id, per buffer, for reading positions back.
local marks_by_buffer = {}

--- The absolute path a buffer edits, or nil for buffers that are not files.
local function buffer_path(buffer)
  if not vim.api.nvim_buf_is_loaded(buffer) or vim.bo[buffer].buftype ~= '' then
    return nil
  end
  local name = vim.api.nvim_buf_get_name(buffer)
  if name == '' then
    return nil
  end
  return vim.fn.fnamemodify(name, ':p')
end

--- The sign a breakpoint shows: what it is, unless it is off or a running
--- session did not accept it.
local function sign_for(breakpoint)
  if not breakpoint.enabled then
    return SIGNS.disabled
  end
  if state.sessionActive and not breakpoint.verified then
    return SIGNS.unverified
  end
  if breakpoint.kind == 'log' then
    return SIGNS.log
  end
  if breakpoint.kind == 'conditional' then
    return SIGNS.conditional
  end
  return SIGNS.breakpoint
end

local function place_breakpoint(buffer, breakpoint, line_count)
  if breakpoint.line < 1 or breakpoint.line > line_count then
    return
  end
  local sign = sign_for(breakpoint)
  local ok, mark = pcall(vim.api.nvim_buf_set_extmark, buffer, namespace, breakpoint.line - 1, 0, {
    sign_text = sign.text,
    sign_hl_group = sign.hl,
    priority = BREAKPOINT_PRIORITY
  })
  if ok then
    marks_by_buffer[buffer][mark] = breakpoint.id
  end
end

local function place_stopped(buffer, line_count)
  local stopped = state.stopped
  if stopped == vim.NIL or stopped == nil or stopped.line > line_count then
    return
  end
  pcall(vim.api.nvim_buf_set_extmark, buffer, namespace, stopped.line - 1, 0, {
    sign_text = SIGNS.stopped.text,
    sign_hl_group = SIGNS.stopped.hl,
    line_hl_group = 'GroveDebugStoppedLine',
    priority = STOPPED_PRIORITY
  })
end

--- Redraws one buffer's breakpoints and stopped line from the state.
local function draw(buffer)
  local path = buffer_path(buffer)
  if path == nil then
    return
  end
  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  marks_by_buffer[buffer] = {}
  local line_count = vim.api.nvim_buf_line_count(buffer)
  for _, breakpoint in ipairs(state.breakpoints) do
    if breakpoint.path == path then
      place_breakpoint(buffer, breakpoint, line_count)
    end
  end
  if state.stopped ~= vim.NIL and state.stopped ~= nil and state.stopped.path == path then
    place_stopped(buffer, line_count)
  end
end

--- Adopts the state Grove pushed and redraws every loaded buffer.
function M.sync(next_state)
  state = next_state
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    draw(buffer)
  end
end

--- Asks Grove to add or remove the breakpoint on a line of a buffer.
function M.toggle(buffer, line)
  local path = buffer_path(buffer)
  if path == nil then
    return
  end
  vim.rpcnotify(0, 'grove_debug_toggle_breakpoint', { path = path, line = line })
end

--- Reports where this buffer's breakpoint marks are now, if any moved.
local function report_moves(buffer)
  local path = buffer_path(buffer)
  local marks = marks_by_buffer[buffer]
  if path == nil or marks == nil then
    return
  end
  local moves = {}
  for mark, breakpoint_id in pairs(marks) do
    local position = vim.api.nvim_buf_get_extmark_by_id(buffer, namespace, mark, {})
    if position[1] ~= nil then
      moves[#moves + 1] = { id = breakpoint_id, line = position[1] + 1 }
    end
  end
  if #moves > 0 then
    vim.rpcnotify(0, 'grove_debug_breakpoints_moved', { path = path, moves = moves })
  end
end

--- Whether a mouse position is in a file window's gutter (signs and numbers).
local function in_gutter(mouse)
  if mouse.winid == 0 or mouse.line == 0 then
    return false
  end
  local buffer = vim.api.nvim_win_get_buf(mouse.winid)
  if buffer_path(buffer) == nil then
    return false
  end
  local info = vim.fn.getwininfo(mouse.winid)[1]
  return info ~= nil and mouse.wincol >= 1 and mouse.wincol <= info.textoff
end

--- A click in the gutter toggles that line's breakpoint; any other click is a click.
local function gutter_click()
  local mouse = vim.fn.getmousepos()
  if not in_gutter(mouse) then
    return '<LeftMouse>'
  end
  local buffer = vim.api.nvim_win_get_buf(mouse.winid)
  vim.schedule(function()
    M.toggle(buffer, mouse.line)
  end)
  return ''
end

function M.setup()
  define_default_highlights()
  vim.api.nvim_create_autocmd('ColorScheme', { callback = define_default_highlights })

  local group = vim.api.nvim_create_augroup('grove_debug', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile', 'BufFilePost' }, {
    group = group,
    callback = function(args)
      draw(args.buf)
    end
  })
  vim.api.nvim_create_autocmd('BufWritePost', {
    group = group,
    callback = function(args)
      report_moves(args.buf)
    end
  })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    callback = function(args)
      marks_by_buffer[args.buf] = nil
    end
  })

  vim.keymap.set('n', '<LeftMouse>', gutter_click, {
    expr = true,
    replace_keycodes = true,
    desc = 'Click, or toggle a breakpoint in the gutter'
  })

  vim.rpcnotify(0, 'grove_debug_ready', {})
end

return M
