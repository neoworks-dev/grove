-- Grove-managed Neovim config for the embedded editor pane. Grove starts nvim
-- with `-u` on this file and XDG_CONFIG_HOME=~/.config/grove, so the user's own
-- ~/.config/nvim is never touched. Grove owns tabs and the statusline, so nvim's chrome is
-- disabled; the in-grid cmdline row stays (search/:s preview, wildmenu,
-- hit-enter prompts).
--
-- The config itself lives in lua/grove/, one module per concern, loaded here
-- in order: options and plugins first, since everything after maps keys and
-- sets highlights on top of them.

-- `-u` does not put this directory on 'runtimepath', and lazy.nvim resets
-- 'runtimepath' anyway, so the modules are found through package.path.
local configDir = vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))
package.path = table.concat({
  vim.fs.joinpath(configDir, "lua", "?.lua"),
  vim.fs.joinpath(configDir, "lua", "?", "init.lua"),
  package.path,
}, ";")

require("grove.options")
require("grove.windows")
require("grove.plugins")
require("grove.provision")
require("grove.language_dump")
require("grove.diagnostics")
require("grove.lsp")
require("grove.keymaps")
require("grove.theme")
require("grove.code_context")
require("grove.prompt_blame")
require("grove.popup_menu")
require("grove.ui_select")
require("grove.previews")
require("grove.terminal")

-- The debugger's breakpoints and stopped line, drawn from Grove's state, and
-- gutter clicks that toggle a breakpoint (see lua/grove/debug.lua).
_G.grove_debug = require("grove.debug")
_G.grove_debug.setup()

-- Sanctioned user-extension hook (Phase C): a writable init in nvim's data
-- dir (grove userData) is sourced last when present.
pcall(dofile, vim.fs.joinpath(vim.fn.stdpath("data"), "user", "init.lua"))
