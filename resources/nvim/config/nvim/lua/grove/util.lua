-- What more than one of grove's config modules needs: where the config lives,
-- what first-run setup installs, and the helper that maps a leader action.

local M = {}

-- The config dir (the one holding init.lua): this file sits in lua/grove/.
M.config_dir = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))))

--- The plugin spec, mason packages and parsers. Kept apart from the rest of the
--- config so that editing it does not rerun first-run setup: grove hashes
--- installs.lua alone to decide that (src/main/nvimSetup.ts).
function M.load_installs()
  return dofile(vim.fs.joinpath(M.config_dir, "installs.lua"))
end

--- Maps `<leader>` + keys in normal and visual mode.
function M.leader(keys, action, desc)
  vim.keymap.set({ "n", "x" }, "<leader>" .. keys, action, { desc = desc })
end

return M
