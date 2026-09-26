// Lines an agent pointed at, painted into the editor.
//
// Extmarks rather than a selection: the mark survives the cursor moving and
// follows its lines as the buffer is edited. It lives in its own namespace, so
// wiping it is one call per buffer.

// The mark's colours, from the palette the theme push is given: a violet wash,
// a bar in the sign column, the note in violet and line remarks dimmer. Defined
// here rather than in the bundled init.lua, whose contents key the first-run
// setup — a colour added there reinstalls every plugin on the next launch.
// Runs inside the theme push, after grove's own theme, with \`palette\` in scope.
export const AGENT_MARK_HIGHLIGHTS_LUA = `
do
  local function channels(hex)
    local h = hex:gsub('#', '')
    return tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16)
  end
  local function blend(base, tint, ratio)
    local br, bg, bb = channels(base)
    local tr, tg, tb = channels(tint)
    local function mix(a, b) return math.floor(a + (b - a) * ratio + 0.5) end
    return string.format('#%02x%02x%02x', mix(br, tr), mix(bg, tg), mix(bb, tb))
  end
  local set = vim.api.nvim_set_hl
  set(0, 'GroveAgentMark', { bg = blend(palette.surface, palette.ctxViolet, 0.16) })
  set(0, 'GroveAgentMarkSign', { fg = palette.ctxViolet, bg = palette.surface })
  set(0, 'GroveAgentMarkNote', { fg = palette.ctxViolet, italic = true })
  set(0, 'GroveAgentMarkAnnotation', { fg = blend(palette.textMuted, palette.ctxViolet, 0.5), italic = true })
end
`

// Mark lines start..end (1-based, inclusive) of the current buffer. The note —
// when there is one — goes above the first line, and each annotation above the
// line it is about, all wrapped to the window so nothing runs off its edge.
//
// One location is open at a time, so the previous mark goes first, in whichever
// buffer it was. Lines are clamped to the buffer, since a model can name lines
// past the end of a file.
export const MARK_LINES_LUA = `
local start_line, end_line, note, annotations = ...
local ns = vim.api.nvim_create_namespace('grove_agent_marks')
for _, other in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(other) then
    vim.api.nvim_buf_clear_namespace(other, ns, 0, -1)
  end
end

local buf = vim.api.nvim_get_current_buf()
local last = vim.api.nvim_buf_line_count(buf)
local first = math.min(start_line, last)
local final = math.min(math.max(end_line, first), last)
local width = math.max(30, vim.api.nvim_win_get_width(0) - 12)

local function wrapped(text, group)
  local lines, current = {}, ''
  for word in tostring(text):gmatch('%S+') do
    if current ~= '' and #current + #word + 1 > width then
      table.insert(lines, { { '  ' .. current, group } })
      current = word
    elseif current == '' then
      current = word
    else
      current = current .. ' ' .. word
    end
  end
  if current ~= '' then table.insert(lines, { { '  ' .. current, group } }) end
  return lines
end

local function has_text(value)
  return value ~= nil and value ~= vim.NIL and value ~= ''
end

for line = first, final do
  vim.api.nvim_buf_set_extmark(buf, ns, line - 1, 0, {
    line_hl_group = 'GroveAgentMark',
    sign_text = '▎',
    sign_hl_group = 'GroveAgentMarkSign',
    priority = 20
  })
end

local above = {}
local function add_above(line, text, group)
  if line < 1 or line > last then return end
  above[line] = above[line] or {}
  vim.list_extend(above[line], wrapped(text, group))
end
if has_text(note) then add_above(first, note, 'GroveAgentMarkNote') end
if annotations ~= nil and annotations ~= vim.NIL then
  for _, entry in ipairs(annotations) do
    add_above(entry.line, '› ' .. entry.text, 'GroveAgentMarkAnnotation')
  end
end
for line, virt in pairs(above) do
  vim.api.nvim_buf_set_extmark(buf, ns, line - 1, 0, { virt_lines = virt, virt_lines_above = true })
end

-- Lines above the first line of a buffer only show once the view is scrolled up
-- into them, which it never is on its own.
if above[1] and vim.fn.line('w0') == 1 then
  vim.fn.winrestview({ topline = 1, topfill = #above[1] })
end
`

// Wipe every agent mark, in every buffer.
export const CLEAR_MARKS_LUA = `
local ns = vim.api.nvim_create_namespace('grove_agent_marks')
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(buf) then
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  end
end
`
