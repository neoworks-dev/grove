-- Prompt blame. When the cursor rests on a line, grove is told which; if an
-- agent wrote it, grove answers with grove_show_prompt_blame, which puts the
-- commit and the prompt that wrote the line at its end. Lines a person wrote
-- get nothing, and the text goes as soon as the cursor moves.
local leader = require("grove.util").leader

local prompt_blame_ns = vim.api.nvim_create_namespace("grove_prompt_blame")
local prompt_blame_timer = nil
local prompt_blame_buf = nil

--- The cursor line of a file buffer, as grove blames it; nil anywhere else.
local function grove_blame_context()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].buftype ~= "" then
    return nil
  end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" then
    return nil
  end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local text = vim.api.nvim_buf_get_lines(buf, line - 1, line, false)[1] or ""
  return { buf = buf, path = name, line = line, text = text }
end

local function clear_prompt_blame()
  if prompt_blame_buf and vim.api.nvim_buf_is_valid(prompt_blame_buf) then
    vim.api.nvim_buf_clear_namespace(prompt_blame_buf, prompt_blame_ns, 0, -1)
  end
  prompt_blame_buf = nil
end

vim.api.nvim_create_autocmd({ "CursorMoved", "BufEnter", "InsertLeave" }, {
  group = vim.api.nvim_create_augroup("grove.prompt_blame", { clear = true }),
  callback = function()
    clear_prompt_blame()
    if prompt_blame_timer then
      prompt_blame_timer:stop()
    end
    prompt_blame_timer = vim.defer_fn(function()
      if vim.api.nvim_get_mode().mode ~= "n" then
        return
      end
      local context = grove_blame_context()
      if context then
        vim.rpcnotify(0, "grove_line_blame", context)
      end
    end, 400)
  end,
})
vim.api.nvim_create_autocmd("InsertEnter", { group = "grove.prompt_blame", callback = clear_prompt_blame })

--- Shows `label` at the end of `line`, if the cursor is still on it reading `text`.
_G.grove_show_prompt_blame = function(buf, line, text, label)
  if buf ~= vim.api.nvim_get_current_buf() or not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  if vim.api.nvim_win_get_cursor(0)[1] ~= line then
    return
  end
  if (vim.api.nvim_buf_get_lines(buf, line - 1, line, false)[1] or "") ~= text then
    return
  end
  clear_prompt_blame()
  vim.api.nvim_buf_set_extmark(buf, prompt_blame_ns, line - 1, 0, {
    virt_text = { { "    " .. label, "GroveAgentMarkAnnotation" } },
    virt_text_pos = "eol",
    hl_mode = "combine",
  })
  prompt_blame_buf = buf
end

-- Blame line: gitsigns' popup, then whatever prompt wrote the line. Once
-- gitsigns is done, grove is asked; it answers with grove_extend_blame_popup,
-- which appends the agent's explanation and prompt when an agent wrote the line.
leader("gb", function()
  local context = grove_blame_context()
  require("gitsigns").blame_line({ full = true }, function()
    if context then
      vim.rpcnotify(0, "grove_line_blame_popup", context)
    end
  end)
end, "Blame line")

--- Opens a blame popup of grove's own, in gitsigns' style and under its id so
--- it closes, refocuses and is replaced exactly like gitsigns' own. Needed
--- because gitsigns does not attach to untracked files and opens nothing there.
local function open_grove_blame_popup(heading)
  local config = require("gitsigns.config").config
  return require("gitsigns.popup").create({ { { heading, "Title" } } }, config.preview_config, "blame")
end

--- Appends `lines` ({ text, highlight } pairs) to the blame popup `win`, then
--- rewraps it to fit the editor, since prompts run long.
local function append_blame_lines(win, lines)
  local popup_buf = vim.api.nvim_win_get_buf(win)
  local first = vim.api.nvim_buf_line_count(popup_buf)
  local texts = { "" }
  for _, entry in ipairs(lines) do
    table.insert(texts, entry[1])
  end
  vim.bo[popup_buf].modifiable = true
  vim.api.nvim_buf_set_lines(popup_buf, first, first, false, texts)
  vim.bo[popup_buf].modifiable = false
  for index, entry in ipairs(lines) do
    if entry[2] ~= "" then
      vim.api.nvim_buf_set_extmark(popup_buf, prompt_blame_ns, first + index, 0, {
        end_row = first + index,
        end_col = #entry[1],
        hl_group = entry[2],
      })
    end
  end
  local width = 0
  for _, text in ipairs(vim.api.nvim_buf_get_lines(popup_buf, 0, -1, false)) do
    width = math.max(width, vim.fn.strdisplaywidth(text))
  end
  width = math.max(1, math.min(width, vim.o.columns - 4))
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.api.nvim_win_set_width(win, width)
  local height = vim.api.nvim_win_text_height(win, {}).all
  vim.api.nvim_win_set_height(win, math.max(1, math.min(height, vim.o.lines - 4)))
end

--- Finishes the blame popup for `line` of `buf`, if the cursor is still there:
--- appends `lines` to gitsigns' popup, or, when gitsigns opened none, opens
--- grove's own headed `heading`. Each popup gets the lines once.
_G.grove_extend_blame_popup = function(buf, line, heading, lines)
  if buf ~= vim.api.nvim_get_current_buf() then
    return
  end
  if vim.api.nvim_win_get_cursor(0)[1] ~= line then
    return
  end
  local win = require("gitsigns.popup").is_open("blame")
  if not win then
    win = open_grove_blame_popup(heading)
  end
  if vim.w[win].grove_prompt_blame or #lines == 0 then
    return
  end
  vim.w[win].grove_prompt_blame = true
  append_blame_lines(win, lines)
end
