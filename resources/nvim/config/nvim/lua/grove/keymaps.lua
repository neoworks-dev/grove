-- LazyVim's leader actions, as plain maps. Grove reads every <leader> map in
-- normal and visual mode and lists it in its own overlay under the which-key
-- group of its prefix, so these are rebindable in Keyboard Shortcuts like any
-- plugin's maps — nothing here is specific to grove.

local leader = require("grove.util").leader

--- Maps a UI toggle that reports which way it went.
local function toggle(keys, label, flip)
  vim.keymap.set("n", "<leader>" .. keys, function()
    local state = "off"
    if flip() then
      state = "on"
    end
    vim.notify(label .. " " .. state)
  end, { desc = "Toggle " .. label:lower() })
end

--- Flips a window option and returns its new value.
local function flipWindowOption(name)
  return function()
    vim.wo[name] = not vim.wo[name]
    return vim.wo[name]
  end
end

leader("ca", vim.lsp.buf.code_action, "Code action")
leader("cA", function()
  vim.lsp.buf.code_action({ context = { only = { "source" }, diagnostics = {} } })
end, "Source action")
leader("co", function()
  vim.lsp.buf.code_action({ apply = true, context = { only = { "source.organizeImports" }, diagnostics = {} } })
end, "Organize imports")
leader("cr", vim.lsp.buf.rename, "Rename")
leader("cf", function()
  require("conform").format({ lsp_format = "fallback" })
end, "Format")
leader("cc", vim.lsp.codelens.run, "Run codelens")
leader("cC", function()
  vim.lsp.codelens.refresh({ bufnr = 0 })
end, "Refresh and show codelens")
leader("cd", vim.diagnostic.open_float, "Line diagnostics")
leader("cl", "<cmd>checkhealth vim.lsp<cr>", "LSP info")
leader("cm", "<cmd>Mason<cr>", "Mason")

-- <leader>gb (Blame line) is defined in prompt_blame.lua: it adds the
-- agent's explanation and prompt to gitsigns' popup.
leader("ghs", function()
  require("gitsigns").stage_hunk()
end, "Stage hunk")
leader("ghr", function()
  require("gitsigns").reset_hunk()
end, "Reset hunk")
leader("ghS", function()
  require("gitsigns").stage_buffer()
end, "Stage buffer")
leader("ghR", function()
  require("gitsigns").reset_buffer()
end, "Reset buffer")
leader("ghp", function()
  require("gitsigns").preview_hunk_inline()
end, "Preview hunk inline")
leader("ghB", function()
  require("gitsigns").blame()
end, "Blame buffer")

-- LazyVim's other key for it: <leader>b is Grove's buffer group, run on its tabs.
vim.keymap.set("n", "<leader>`", "<cmd>buffer #<cr>", { desc = "Switch to other buffer" })

toggle("uf", "Format on save", function()
  vim.g.grove_autoformat = vim.g.grove_autoformat == false
  return vim.g.grove_autoformat
end)
toggle("us", "Spelling", flipWindowOption("spell"))
toggle("uw", "Wrap", flipWindowOption("wrap"))
toggle("ul", "Line numbers", flipWindowOption("number"))
toggle("uL", "Relative numbers", flipWindowOption("relativenumber"))
toggle("ud", "Diagnostics", function()
  vim.diagnostic.enable(not vim.diagnostic.is_enabled())
  return vim.diagnostic.is_enabled()
end)
toggle("uh", "Inlay hints", function()
  local enabled = not vim.lsp.inlay_hint.is_enabled({ bufnr = 0 })
  vim.lsp.inlay_hint.enable(enabled, { bufnr = 0 })
  return enabled
end)

-- Grove reads the keymap on attach and on opening a file. Language servers,
-- filetype plugins and lazy-loaded plugins map keys after that, so tell grove
-- to read it again. Coalesced: one read however many fire in a tick.
local grove_keymap_change_queued = false

--- Asks grove to re-read the keymap, once per tick.
local function grove_notify_keymap_changed()
  if grove_keymap_change_queued then
    return
  end
  grove_keymap_change_queued = true
  vim.schedule(function()
    grove_keymap_change_queued = false
    vim.rpcnotify(0, "grove_keymap_changed", {})
  end)
end

vim.api.nvim_create_autocmd({ "LspAttach", "FileType" }, {
  callback = grove_notify_keymap_changed,
})
vim.api.nvim_create_autocmd("User", {
  pattern = "LazyLoad",
  callback = grove_notify_keymap_changed,
})
