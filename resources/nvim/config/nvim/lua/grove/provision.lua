-- First-run setup. Grove runs this config once in a headless nvim with
-- GROVE_PROVISION=1 before any editor starts, and waits for it: plugins, the
-- completion binary, mason's tools and servers and the treesitter parsers are
-- all installed here. Editors started while those installers ran would each
-- raise a hit-enter prompt per progress message; headless has no UI to prompt
-- in, and the editors that follow find nothing left to install. Each step is
-- announced on stderr as "grove-setup: <step>" for grove to show; the exit code
-- says whether everything landed, so a failure is retried next launch.
local installs = require("grove.util").load_installs()
local masonPackages = installs.masonPackages
local treesitterParsers = installs.treesitterParsers
local provisionTimeoutMs = 600000

--- Tells grove which setup step is running.
local function announceSetupStep(step)
  -- Headless nvim ends its own messages without a newline; start a fresh line.
  io.stderr:write("\ngrove-setup: " .. step .. "\n")
end

--- Whether lazy installed every declared plugin.
local function pluginsInstalled()
  local ok, lazy = pcall(require, "lazy")
  if not ok then
    return false
  end
  for _, plugin in ipairs(lazy.plugins()) do
    if not plugin._.installed then
      return false
    end
  end
  return true
end

--- Downloads blink.cmp's prebuilt fuzzy matcher. Returns whether it is there.
local function downloadCompletionBinary()
  local ok, download = pcall(require, "blink.cmp.fuzzy.download")
  if not ok then
    return false
  end
  local finished = false
  local failure = nil
  download.ensure_downloaded(function(err)
    failure = err
    finished = true
  end)
  vim.wait(provisionTimeoutMs, function()
    return finished
  end, 100)
  return finished and failure == nil
end

--- Installs every mason package. Returns whether all landed.
local function installMasonPackages()
  local ok, toolInstaller = pcall(require, "mason-tool-installer")
  if not ok then
    return false
  end
  toolInstaller.check_install(false, true)
  local registry = require("mason-registry")
  for _, name in ipairs(masonPackages) do
    if not registry.is_installed(name) then
      return false
    end
  end
  return true
end

--- Installs the treesitter parsers. Returns whether every one is installed.
local function installParsers()
  local ok, treesitter = pcall(require, "nvim-treesitter")
  if not ok or vim.fn.executable("tree-sitter") ~= 1 then
    return false
  end
  pcall(function()
    treesitter.install(treesitterParsers):wait(provisionTimeoutMs)
  end)
  local installed = treesitter.get_installed()
  for _, parser in ipairs(treesitterParsers) do
    if not vim.tbl_contains(installed, parser) then
      return false
    end
  end
  return true
end

--- Runs one setup step. Returns whether it succeeded, saying so on stderr if not.
local function runSetupStep(step, run)
  if step ~= nil then
    announceSetupStep(step)
  end
  local ok, succeeded = pcall(run)
  if ok and succeeded then
    return true
  end
  -- The marker line names the step alone, for grove to report; an error the
  -- step raised follows on its own line for the log.
  io.stderr:write("\ngrove-setup failed: " .. (step or "Installing plugins") .. "\n")
  if not ok then
    io.stderr:write(tostring(succeeded) .. "\n")
  end
  return false
end

--- Runs every setup step, then quits with an exit code saying if all landed.
local function provision()
  local complete = runSetupStep(nil, pluginsInstalled)
  complete = runSetupStep("Downloading the completion engine", downloadCompletionBinary) and complete
  complete = runSetupStep("Installing language servers and tools", installMasonPackages) and complete
  complete = runSetupStep("Installing syntax parsers", installParsers) and complete
  if complete then
    vim.cmd("qall!")
  else
    vim.cmd("cquit! 1")
  end
end

if vim.env.GROVE_PROVISION == "1" then
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function()
      -- Scheduled so mason-lspconfig and the tool installer have queued the
      -- installs they start on entering. An error must still quit: a headless
      -- nvim left running would hold every editor back until grove's timeout.
      vim.schedule(function()
        local ok, err = pcall(provision)
        if not ok then
          io.stderr:write(tostring(err) .. "\n")
          vim.cmd("cquit! 1")
        end
      end)
    end,
  })
end

-- Installs one Mason package and quits, for Grove's debugger (installing a
-- debug adapter on demand, src/main/debug/mason.ts). Headless like first-run
-- setup, so the package lands in the editor's own Mason directory. The exit
-- code says whether it is installed.
local masonInstallTimeoutMs = 600000

--- Installs a Mason package by name. Returns whether it is installed.
local function installMasonPackage(name)
  local registry = require("mason-registry")
  local finished = false
  local installed = false
  registry.refresh(function()
    local found, masonPackage = pcall(registry.get_package, name)
    if not found then
      io.stderr:write("mason has no package named " .. name .. "\n")
      finished = true
      return
    end
    if masonPackage:is_installed() then
      installed = true
      finished = true
      return
    end
    masonPackage:install({}, function(success, result)
      installed = success
      if not success then
        io.stderr:write(tostring(result) .. "\n")
      end
      finished = true
    end)
  end)
  vim.wait(masonInstallTimeoutMs, function()
    return finished
  end, 200)
  return installed
end

if vim.env.GROVE_MASON_INSTALL ~= nil and vim.env.GROVE_MASON_INSTALL ~= "" then
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function()
      vim.schedule(function()
        local ok, installed = pcall(installMasonPackage, vim.env.GROVE_MASON_INSTALL)
        if not ok then
          io.stderr:write(tostring(installed) .. "\n")
        end
        if ok and installed then
          vim.cmd("qall!")
        else
          vim.cmd("cquit! 1")
        end
      end)
    end,
  })
end
