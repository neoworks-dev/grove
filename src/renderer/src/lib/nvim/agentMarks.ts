// Lines an agent marked for the user to look at, painted into the editor.
//
// Extmarks rather than a selection: they survive the cursor moving, several can
// stand at once across files, and they follow the lines as the buffer is edited.
// All of them live in one namespace, so wiping them is one call per buffer.

// Mark lines start..end (1-based, inclusive) of the current buffer, with the
// note — when there is one — as a virtual line above the first. Clamped to the
// buffer, since a model can name lines past the end of a file.
export const MARK_LINES_LUA = `
local start_line, end_line, note = ...
local ns = vim.api.nvim_create_namespace('grove_agent_marks')
local buf = vim.api.nvim_get_current_buf()
local last = vim.api.nvim_buf_line_count(buf)
local first = math.min(start_line, last)
local final = math.min(math.max(end_line, first), last)
for line = first, final do
  local mark = { line_hl_group = 'GroveAgentMark', sign_text = '▎', sign_hl_group = 'GroveAgentMarkSign', priority = 20 }
  if line == first and note ~= vim.NIL and note ~= nil and note ~= '' then
    mark.virt_lines = { { { '  ' .. note, 'GroveAgentMarkNote' } } }
    mark.virt_lines_above = true
  end
  vim.api.nvim_buf_set_extmark(buf, ns, line - 1, 0, mark)
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
