-- Plugin manager bootstrap. lazy.nvim clones itself and the declared plugins
-- into the writable data dir (XDG_DATA_HOME → grove userData) on first launch;
-- the user's own nvim install is untouched. Offline-tolerant: a failed clone
-- just leaves the editor plugin-less.
local dataDir = vim.fn.stdpath("data")
local lazyPath = vim.fs.joinpath(dataDir, "lazy", "lazy.nvim")
-- Checked by its entry file, not by the directory: a clone cut short (the app
-- quit mid-bootstrap) leaves the directory behind empty, and that alone must
-- not count as installed or no plugin ever loads again.
local lazyEntry = vim.fs.joinpath(lazyPath, "lua", "lazy", "init.lua")

-- Clone lazy.nvim beside its final path and move it into place once complete.
-- Every pane is its own nvim and they start together on a fresh profile, so
-- several run this at once; cloning straight into the shared path had them
-- clobber each other's half-written checkout.
local function bootstrapLazy()
  local uv = vim.uv or vim.loop
  -- Outside lazy's plugin root, so a leftover never shows up as a plugin.
  local staging = vim.fs.joinpath(dataDir, "lazy-bootstrap-" .. vim.fn.getpid())
  vim.fn.delete(staging, "rf")
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "--branch=stable",
    "https://github.com/folke/lazy.nvim.git",
    staging,
  })
  local cloned = uv.fs_stat(vim.fs.joinpath(staging, "lua", "lazy", "init.lua"))
  -- Another nvim may have finished first while this one was cloning.
  if cloned and not uv.fs_stat(lazyEntry) then
    vim.fn.delete(lazyPath, "rf")
    -- On a fresh profile nothing has made lazy's plugin root yet, and a rename
    -- into a missing directory fails, leaving the editor without plugins.
    vim.fn.mkdir(vim.fs.dirname(lazyPath), "p")
    uv.fs_rename(staging, lazyPath)
  end
  vim.fn.delete(staging, "rf")
end

if not (vim.uv or vim.loop).fs_stat(lazyEntry) then
  bootstrapLazy()
end

-- Only one nvim at a time may install plugins. lazy deletes a plugin's
-- directory before cloning it, and a failed `git clone` deletes its target, so
-- panes starting together wiped each other's clones until every one failed and
-- left its `.cloning` marker behind, which lazy reads as "not installed".
-- A directory is the lock because mkdir is atomic; it holds the owner's pid so
-- the lock of an nvim killed mid-install (grove kills a pane's nvim when the
-- pane goes away) can be taken over, and the clones it left unfinished redone.
local installLock = vim.fs.joinpath(dataDir, "lazy-install.lock")
local installLockOwner = vim.fs.joinpath(installLock, "pid")
local installLockTimeoutMs = 180000

--- Whether the nvim that wrote the install lock is still running.
local function installLockOwnerAlive()
  local file = io.open(installLockOwner, "r")
  if not file then
    -- Just created and not yet written: its owner is alive.
    return true
  end
  local pid = tonumber(file:read("*a"))
  file:close()
  if not pid then
    return true
  end
  return (vim.uv or vim.loop).kill(pid, 0) == 0
end

--- Takes the install lock, clearing one left by a dead nvim. Returns false
--- when a live nvim holds it.
local function takeInstallLock()
  local uv = vim.uv or vim.loop
  if not uv.fs_mkdir(installLock, 493) then
    if installLockOwnerAlive() then
      return false
    end
    vim.fn.delete(installLock, "rf")
    if not uv.fs_mkdir(installLock, 493) then
      return false
    end
  end
  local file = io.open(installLockOwner, "w")
  if file then
    file:write(tostring(vim.fn.getpid()))
    file:close()
  end
  return true
end

--- Releases the install lock.
local function releaseInstallLock()
  vim.fn.delete(installLock, "rf")
end

--- Whether the install lock is free to take: released, or its owner is dead.
local function installLockFree()
  if not (vim.uv or vim.loop).fs_stat(installLock) then
    return true
  end
  return not installLockOwnerAlive()
end

--- Takes the install lock, waiting while another nvim installs. Every nvim
--- holds it for its own lazy setup, which then finds nothing left to install or
--- finishes what a killed owner started. Returns false when the wait timed out.
local function acquireInstallLock()
  local deadline = (vim.uv or vim.loop).now() + installLockTimeoutMs
  while not takeInstallLock() do
    local remaining = deadline - (vim.uv or vim.loop).now()
    if remaining <= 0 then
      return false
    end
    vim.wait(remaining, installLockFree, 200)
  end
  return true
end

--- Closes lazy's floating view if the startup install opened it. lazy shows it
--- whenever a UI is attached, which grove always is, and grove then opens the
--- pane's file in the current window — that float.
local function closeLazyView()
  local ok, view = pcall(require, "lazy.view")
  if not ok or not view.visible() then
    return
  end
  view.view:close()
end

local installs = require("grove.util").load_installs()

if (vim.uv or vim.loop).fs_stat(lazyEntry) then
  vim.opt.rtp:prepend(lazyPath)
  local installsPlugins = acquireInstallLock()
  pcall(function()
    require("lazy").setup(installs.plugins, {
      root = vim.fs.joinpath(dataDir, "lazy"),
      lockfile = vim.fs.joinpath(dataDir, "lazy-lock.json"),
      -- Grove owns the chrome; keep lazy from drawing its own UI on startup.
      install = { missing = installsPlugins, colorscheme = {} },
      ui = { border = "rounded" },
      change_detection = { enabled = false },
    })
  end)
  if installsPlugins then
    releaseInstallLock()
  end
  closeLazyView()
end
