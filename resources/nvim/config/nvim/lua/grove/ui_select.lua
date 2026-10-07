-- vim.ui.select (code actions, and any plugin asking for a choice) opens
-- grove's picker instead of nvim's numbered inputlist, which grove can only
-- show as a blocking prompt. Grove answers through grove_ui_select_done.
local grove_ui_select_pending = {}
local grove_ui_select_next_id = 0

--- One select item as grove lists it. A code action the server offers but
--- can't apply here comes with the reason, so grove can list it apart instead
--- of burying the usable ones under "(disabled)" titles.
local function grove_ui_select_entry(item, opts)
  local action = type(item) == "table" and item.action or nil
  if opts.kind == "codeaction" and type(action) == "table" and action.title then
    local entry = { label = action.title }
    if action.disabled then
      entry.disabled = action.disabled.reason or "disabled"
    end
    return entry
  end
  local format_item = opts.format_item or tostring
  return { label = format_item(item) }
end

vim.ui.select = function(items, opts, on_choice)
  opts = opts or {}
  local entries = {}
  for index, item in ipairs(items) do
    entries[index] = grove_ui_select_entry(item, opts)
  end
  grove_ui_select_next_id = grove_ui_select_next_id + 1
  grove_ui_select_pending[grove_ui_select_next_id] = { items = items, on_choice = on_choice }
  vim.rpcnotify(0, "grove_ui_select", {
    id = grove_ui_select_next_id,
    prompt = opts.prompt,
    kind = opts.kind,
    items = entries,
  })
end

-- Hand grove's pick (a 1-based index, or nil when cancelled) to the caller.
_G.grove_ui_select_done = function(id, index)
  local pending = grove_ui_select_pending[id]
  if pending == nil then
    return
  end
  grove_ui_select_pending[id] = nil
  -- Scheduled so the callback runs outside the RPC request, free to prompt again.
  vim.schedule(function()
    if index == nil then
      pending.on_choice(nil, nil)
      return
    end
    pending.on_choice(pending.items[index], index)
  end)
end
