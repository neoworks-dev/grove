-- Each diagnostic's message at the end of its line, in the severity's colour
-- behind a dot, on top of the underline. Worst first where several share a line.
-- Highlight group per vim.diagnostic.severity, for the float's dots.
local grove_severity_highlight = {
  [vim.diagnostic.severity.ERROR] = "DiagnosticError",
  [vim.diagnostic.severity.WARN] = "DiagnosticWarn",
  [vim.diagnostic.severity.INFO] = "DiagnosticInfo",
  [vim.diagnostic.severity.HINT] = "DiagnosticHint",
}

-- The float's prefix for one diagnostic: a dot in its severity's colour.
local function grove_diagnostic_prefix(diagnostic)
  return "● ", grove_severity_highlight[diagnostic.severity] or "DiagnosticInfo"
end

vim.diagnostic.config({
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  virtual_text = { spacing = 4, source = "if_many", prefix = "●" },
  -- The line's diagnostics float (right-click Show Diagnostics, <C-W>d) reads
  -- like the inline text: no "Diagnostics:" header or "1." numbering, just a
  -- dot in each one's severity colour. Grove draws the frame around it.
  float = { header = "", source = "if_many", prefix = grove_diagnostic_prefix },
})

-- Push LSP/lint diagnostics to grove's native Diagnostics pane. rpcnotify(0,…)
-- broadcasts to grove's msgpack channel, where the main process forwards it to
-- the renderer. Debounced so a burst of DiagnosticChanged (e.g. a multi-file
-- lint pass) collapses into one broadcast.
local diagnostics_timer = nil
local function grove_push_diagnostics()
  local out = {}
  for _, d in ipairs(vim.diagnostic.get()) do
    out[#out + 1] = {
      path = vim.api.nvim_buf_get_name(d.bufnr),
      lnum = d.lnum,
      col = d.col,
      severity = d.severity,
      message = d.message,
      source = d.source,
    }
  end
  vim.rpcnotify(0, "grove_diagnostics", out)
end
vim.api.nvim_create_autocmd("DiagnosticChanged", {
  callback = function()
    if diagnostics_timer then
      diagnostics_timer:stop()
    end
    diagnostics_timer = vim.defer_fn(grove_push_diagnostics, 150)
  end,
})

-- Diagnostic lists open in grove's Diagnostics pane, not a quickfix or location
-- split: the right-click menu's "Show All Diagnostics" and any plugin or map
-- that calls setqflist/setloclist all land there. A caller that asks for the
-- list without opening it (open = false) still gets nvim's own.
local function grove_diagnostics_list(original)
  return function(opts)
    if opts ~= nil and opts.open == false then
      return original(opts)
    end
    grove_push_diagnostics()
    vim.rpcnotify(0, "grove_show_diagnostics")
  end
end
vim.diagnostic.setqflist = grove_diagnostics_list(vim.diagnostic.setqflist)
vim.diagnostic.setloclist = grove_diagnostics_list(vim.diagnostic.setloclist)
