-- Grove-managed Neovim config for the embedded editor pane. Grove starts nvim
-- with `-u` on this file and XDG_CONFIG_HOME=~/.config/grove, so the user's own
-- ~/.config/nvim is never touched. Grove owns tabs and the statusline, so nvim's chrome is
-- disabled; the in-grid cmdline row stays (search/:s preview, wildmenu,
-- hit-enter prompts).

-- Space is the shared leader: grove owns the space-leader which-key overlay and
-- forwards completed leader sequences back here, so nvim's own <leader> maps
-- appear in that overlay and stay executable. Set before any plugin maps load.
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.signcolumn = 'yes'
vim.opt.laststatus = 0
vim.opt.showtabline = 0
vim.opt.cmdheight = 1
vim.opt.undofile = true
-- Write-backups default to the file's own directory ('.') first, so a session
-- killed mid-:w (e.g. a dev reload) leaves a stray `file~` in the worktree.
-- Keep them in the isolated state dir instead.
vim.opt.backupdir:remove('.')
-- No swapfiles: every grove pane is its own embedded nvim, so two panes editing
-- the same file would collide on a swapfile and trigger a blocking E325 ATTENTION
-- prompt on attach (which aborts the session). Grove owns buffer persistence.
vim.opt.swapfile = false
vim.opt.mouse = 'a'
-- One line per wheel step: grove measures the wheel's travel and sends one
-- step per line of it (lib/nvim/wheel.ts), so a touchpad scrolls as far as
-- the fingers moved rather than three lines per event.
vim.opt.mousescroll = 'ver:1,hor:1'
-- Route yanks and puts through the desktop clipboard. Without this the '+'
-- register is never touched, so nothing yanked in an editor pane can be pasted
-- outside grove. nvim picks its own provider (wl-copy, xclip, pbcopy, win32yank);
-- grove spawns nvim with the full parent environment, so WAYLAND_DISPLAY and
-- DISPLAY are present for the detection to succeed.
vim.opt.clipboard = 'unnamedplus'
-- Keep 4 context lines visible above/below the cursor when scrolling.
vim.opt.scrolloff = 4
-- How long nvim holds a key that starts a longer mapping before acting on it
-- alone. nvim's own <C-W>d makes <C-w> such a key, and grove only hears a key
-- once nvim acts on it, so this is also how long the <C-w> hint waits before
-- its own which-key delay starts. LazyVim's value.
vim.opt.timeoutlen = 300
-- nvim's stock 8-column tab makes anything indented with tabs look twice as
-- deep as the project meant it to. Two is the house style; .editorconfig and
-- vim-sleuth both override this per project, so it only decides files that
-- carry no evidence of their own.
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.softtabstop = 2
vim.opt.expandtab = true
-- Also suppress the swap/attention message class outright as a belt-and-suspenders.
vim.opt.shortmess:append('IA')
vim.opt.fillchars = { eob = ' ' }
-- nvim's stock 'guicursor' names no highlight group, which leaves a GUI with
-- nothing to paint the cursor in but reverse video — so it takes the colour of
-- whatever token it happens to sit on and disappears into a comment or a
-- string. Naming Cursor/lCursor makes every mode report a highlight, and the
-- theme decides what that is.
vim.opt.guicursor = table.concat({
  'n-v-c-sm:block-Cursor/lCursor',
  'i-ci-ve:ver25-Cursor/lCursor',
  'r-cr-o:hor20-Cursor/lCursor',
  't:block-blinkon500-blinkoff500-TermCursor'
}, ',')

-- Second line of defence: even with 'swapfile' off above, a plugin or the user
-- extension hook at the bottom of this file can turn it back on, and a leftover
-- swapfile from an older session would then raise the blocking E325 prompt
-- ("[O]pen Read-Only, (E)dit anyway, …"). That prompt has no answerer in grove:
-- it stalls the msgpack request that opened the file. Answer it as "edit anyway"
-- — grove owns buffer persistence, so a stale swapfile carries nothing to keep.
vim.api.nvim_create_autocmd('SwapExists', {
  callback = function()
    vim.v.swapchoice = 'e'
  end
})

-- Grove shows no tab pages ('showtabline' is 0): its tab strip already is the
-- list of open files. A tab page would take windows somewhere only gt reaches,
-- so none are made. <C-w>T, which moves the current split to a tab page of its
-- own, keeps it as the only window instead; the other files stay in the strip.
vim.keymap.set('n', '<C-w>T', '<Cmd>only<CR>', { desc = 'Keep only this split' })

-- Any other new tab page (:tabnew, :tabedit, :tab split, a plugin) is closed
-- again once the command is done, and its buffer shown in the window it was
-- opened from, where it becomes the active tab in the strip. An empty :tabnew
-- leaves the window as it was and its empty buffer is dropped.
local function grove_fold_tab_page()
  if #vim.api.nvim_list_tabpages() < 2 then
    return
  end
  local buffer = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local named = vim.api.nvim_buf_get_name(buffer) ~= ''
  vim.cmd('tabclose')
  if not named then
    if not vim.bo[buffer].modified then
      pcall(vim.api.nvim_buf_delete, buffer, {})
    end
    return
  end
  vim.api.nvim_win_set_buf(0, buffer)
  pcall(vim.api.nvim_win_set_cursor, 0, cursor)
end
vim.api.nvim_create_autocmd('TabNew', {
  callback = function()
    vim.schedule(grove_fold_tab_page)
  end
})

-- nvim hands every column a resize adds to the current window, so splits end
-- up 13 columns against 161 once the pane grows. Even them out on every resize,
-- as LazyVim does; windows with winfixwidth/winfixheight keep their size.
vim.api.nvim_create_autocmd('VimResized', {
  callback = function()
    local current = vim.fn.tabpagenr()
    vim.cmd('tabdo wincmd =')
    vim.cmd('tabnext ' .. current)
  end
})

-- Plugin manager bootstrap. lazy.nvim clones itself and the declared plugins
-- into the writable data dir (XDG_DATA_HOME → grove userData) on first launch;
-- the user's own nvim install is untouched. Offline-tolerant: a failed clone
-- just leaves the editor plugin-less.
local dataDir = vim.fn.stdpath('data')
local lazyPath = vim.fs.joinpath(dataDir, 'lazy', 'lazy.nvim')
-- Checked by its entry file, not by the directory: a clone cut short (the app
-- quit mid-bootstrap) leaves the directory behind empty, and that alone must
-- not count as installed or no plugin ever loads again.
local lazyEntry = vim.fs.joinpath(lazyPath, 'lua', 'lazy', 'init.lua')

-- Clone lazy.nvim beside its final path and move it into place once complete.
-- Every pane is its own nvim and they start together on a fresh profile, so
-- several run this at once; cloning straight into the shared path had them
-- clobber each other's half-written checkout.
local function bootstrapLazy()
  local uv = vim.uv or vim.loop
  -- Outside lazy's plugin root, so a leftover never shows up as a plugin.
  local staging = vim.fs.joinpath(dataDir, 'lazy-bootstrap-' .. vim.fn.getpid())
  vim.fn.delete(staging, 'rf')
  vim.fn.system({
    'git', 'clone', '--filter=blob:none', '--branch=stable',
    'https://github.com/folke/lazy.nvim.git', staging
  })
  local cloned = uv.fs_stat(vim.fs.joinpath(staging, 'lua', 'lazy', 'init.lua'))
  -- Another nvim may have finished first while this one was cloning.
  if cloned and not uv.fs_stat(lazyEntry) then
    vim.fn.delete(lazyPath, 'rf')
    -- On a fresh profile nothing has made lazy's plugin root yet, and a rename
    -- into a missing directory fails, leaving the editor without plugins.
    vim.fn.mkdir(vim.fs.dirname(lazyPath), 'p')
    uv.fs_rename(staging, lazyPath)
  end
  vim.fn.delete(staging, 'rf')
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
local installLock = vim.fs.joinpath(dataDir, 'lazy-install.lock')
local installLockOwner = vim.fs.joinpath(installLock, 'pid')
local installLockTimeoutMs = 180000

--- Whether the nvim that wrote the install lock is still running.
local function installLockOwnerAlive()
  local file = io.open(installLockOwner, 'r')
  if not file then
    -- Just created and not yet written: its owner is alive.
    return true
  end
  local pid = tonumber(file:read('*a'))
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
    vim.fn.delete(installLock, 'rf')
    if not uv.fs_mkdir(installLock, 493) then
      return false
    end
  end
  local file = io.open(installLockOwner, 'w')
  if file then
    file:write(tostring(vim.fn.getpid()))
    file:close()
  end
  return true
end

--- Releases the install lock.
local function releaseInstallLock()
  vim.fn.delete(installLock, 'rf')
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
  local ok, view = pcall(require, 'lazy.view')
  if not ok or not view.visible() then
    return
  end
  view.view:close()
end

-- The plugin spec, mason packages and parsers, apart from the rest of the config
-- so that editing this file does not rerun first-run setup (see installs.lua).
local configDir = vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2))
local installs = dofile(vim.fs.joinpath(configDir, 'installs.lua'))
local masonPackages = installs.masonPackages
local treesitterParsers = installs.treesitterParsers

if (vim.uv or vim.loop).fs_stat(lazyEntry) then
  vim.opt.rtp:prepend(lazyPath)
  local installsPlugins = acquireInstallLock()
  pcall(function()
    require('lazy').setup(installs.plugins, {
      root = vim.fs.joinpath(dataDir, 'lazy'),
      lockfile = vim.fs.joinpath(dataDir, 'lazy-lock.json'),
      -- Grove owns the chrome; keep lazy from drawing its own UI on startup.
      install = { missing = installsPlugins, colorscheme = {} },
      ui = { border = 'rounded' },
      change_detection = { enabled = false }
    })
  end)
  if installsPlugins then
    releaseInstallLock()
  end
  closeLazyView()
end

-- First-run setup. Grove runs this config once in a headless nvim with
-- GROVE_PROVISION=1 before any editor starts, and waits for it: plugins, the
-- completion binary, mason's tools and servers and the treesitter parsers are
-- all installed here. Editors started while those installers ran would each
-- raise a hit-enter prompt per progress message; headless has no UI to prompt
-- in, and the editors that follow find nothing left to install. Each step is
-- announced on stderr as "grove-setup: <step>" for grove to show; the exit code
-- says whether everything landed, so a failure is retried next launch.
local provisionTimeoutMs = 600000

--- Tells grove which setup step is running.
local function announceSetupStep(step)
  -- Headless nvim ends its own messages without a newline; start a fresh line.
  io.stderr:write('\ngrove-setup: ' .. step .. '\n')
end

--- Whether lazy installed every declared plugin.
local function pluginsInstalled()
  local ok, lazy = pcall(require, 'lazy')
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
  local ok, download = pcall(require, 'blink.cmp.fuzzy.download')
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
  local ok, toolInstaller = pcall(require, 'mason-tool-installer')
  if not ok then
    return false
  end
  toolInstaller.check_install(false, true)
  local registry = require('mason-registry')
  for _, name in ipairs(masonPackages) do
    if not registry.is_installed(name) then
      return false
    end
  end
  return true
end

--- Installs the treesitter parsers. Returns whether every one is installed.
local function installParsers()
  local ok, treesitter = pcall(require, 'nvim-treesitter')
  if not ok or vim.fn.executable('tree-sitter') ~= 1 then
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
  io.stderr:write('\ngrove-setup failed: ' .. (step or 'Installing plugins') .. '\n')
  if not ok then
    io.stderr:write(tostring(succeeded) .. '\n')
  end
  return false
end

--- Runs every setup step, then quits with an exit code saying if all landed.
local function provision()
  local complete = runSetupStep(nil, pluginsInstalled)
  complete = runSetupStep('Downloading the completion engine', downloadCompletionBinary) and complete
  complete = runSetupStep('Installing language servers and tools', installMasonPackages) and complete
  complete = runSetupStep('Installing syntax parsers', installParsers) and complete
  if complete then
    vim.cmd('qall!')
  else
    vim.cmd('cquit! 1')
  end
end

if vim.env.GROVE_PROVISION == '1' then
  vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function()
      -- Scheduled so mason-lspconfig and the tool installer have queued the
      -- installs they start on entering. An error must still quit: a headless
      -- nvim left running would hold every editor back until grove's timeout.
      vim.schedule(function()
        local ok, err = pcall(provision)
        if not ok then
          io.stderr:write(tostring(err) .. '\n')
          vim.cmd('cquit! 1')
        end
      end)
    end
  })
end

-- Installs one Mason package and quits, for Grove's debugger (installing a
-- debug adapter on demand, src/main/debug/mason.ts). Headless like first-run
-- setup, so the package lands in the editor's own Mason directory. The exit
-- code says whether it is installed.
local masonInstallTimeoutMs = 600000

--- Installs a Mason package by name. Returns whether it is installed.
local function installMasonPackage(name)
  local registry = require('mason-registry')
  local finished = false
  local installed = false
  registry.refresh(function()
    local found, masonPackage = pcall(registry.get_package, name)
    if not found then
      io.stderr:write('mason has no package named ' .. name .. '\n')
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
        io.stderr:write(tostring(result) .. '\n')
      end
      finished = true
    end)
  end)
  vim.wait(masonInstallTimeoutMs, function()
    return finished
  end, 200)
  return installed
end

if vim.env.GROVE_MASON_INSTALL ~= nil and vim.env.GROVE_MASON_INSTALL ~= '' then
  vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function()
      vim.schedule(function()
        local ok, installed = pcall(installMasonPackage, vim.env.GROVE_MASON_INSTALL)
        if not ok then
          io.stderr:write(tostring(installed) .. '\n')
        end
        if ok and installed then
          vim.cmd('qall!')
        else
          vim.cmd('cquit! 1')
        end
      end)
    end
  })
end

-- Each diagnostic's message at the end of its line, in the severity's colour
-- behind a dot, on top of the underline. Worst first where several share a line.
-- Highlight group per vim.diagnostic.severity, for the float's dots.
local grove_severity_highlight = {
  [vim.diagnostic.severity.ERROR] = 'DiagnosticError',
  [vim.diagnostic.severity.WARN] = 'DiagnosticWarn',
  [vim.diagnostic.severity.INFO] = 'DiagnosticInfo',
  [vim.diagnostic.severity.HINT] = 'DiagnosticHint',
}

-- The float's prefix for one diagnostic: a dot in its severity's colour.
local function grove_diagnostic_prefix(diagnostic)
  return '● ', grove_severity_highlight[diagnostic.severity] or 'DiagnosticInfo'
end

vim.diagnostic.config({
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  virtual_text = { spacing = 4, source = 'if_many', prefix = '●' },
  -- The line's diagnostics float (right-click Show Diagnostics, <C-W>d) reads
  -- like the inline text: no "Diagnostics:" header or "1." numbering, just a
  -- dot in each one's severity colour. Grove draws the frame around it.
  float = { header = '', source = 'if_many', prefix = grove_diagnostic_prefix }
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
      source = d.source
    }
  end
  vim.rpcnotify(0, 'grove_diagnostics', out)
end
vim.api.nvim_create_autocmd('DiagnosticChanged', {
  callback = function()
    if diagnostics_timer then
      diagnostics_timer:stop()
    end
    diagnostics_timer = vim.defer_fn(grove_push_diagnostics, 150)
  end
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
    vim.rpcnotify(0, 'grove_show_diagnostics')
  end
end
vim.diagnostic.setqflist = grove_diagnostics_list(vim.diagnostic.setqflist)
vim.diagnostic.setloclist = grove_diagnostics_list(vim.diagnostic.setloclist)

-- Nvim's built-in LSP defaults deliberately leave `gd` as Vim's same-file
-- declaration search and put references on `grr`. Grove's goto layer uses the
-- conventional `gd`/`gD`/`gr` keys instead: imports follow their server target
-- and references do not appear to stall waiting for a third key. References
-- are presented by Grove rather than quickfix, so they share the searchable
-- preview overlay used by ripgrep. Remove the longer global mapping so it cannot
-- compete with the buffer-local `gr`.
pcall(vim.keymap.del, 'n', 'grr')

-- Jumps to the one location a goto request found, as nvim does itself: the
-- origin goes on the jumplist and the tag stack, so <C-o> and <C-t> return.
local function grove_jump_to_location(item, origin)
  local target = item.bufnr or vim.fn.bufadd(item.filename)
  vim.cmd("normal! m'")
  vim.fn.settagstack(vim.fn.win_getid(origin.win), {
    items = { { tagname = origin.tagname, from = origin.from } }
  }, 't')
  vim.bo[target].buflisted = true
  vim.api.nvim_win_set_buf(origin.win, target)
  vim.api.nvim_win_set_cursor(origin.win, { item.lnum, item.col - 1 })
  vim._with({ win = origin.win }, function()
    vim.cmd('normal! zv')
  end)
end

-- A quickfix item as grove's location picker takes it. Quickfix columns are
-- bytes, which is what the utf-8 offset encoding means, so the picker's jump
-- lands exactly where nvim's own would.
local function grove_location_from_item(item)
  return {
    path = item.filename,
    uri = vim.uri_from_fname(item.filename),
    line = item.lnum - 1,
    col = item.col - 1,
    endLine = (item.end_lnum or item.lnum) - 1,
    endCol = (item.end_col or item.col) - 1,
    encoding = 'utf-8'
  }
end

-- Goto requests with several answers (merged interfaces, overloads, a symbol
-- two servers both know) open grove's location picker, the one references use,
-- rather than a quickfix split. One answer still jumps straight there. Wraps
-- the functions themselves so nvim's right-click menu and plugins get it too;
-- a caller with its own on_list or a loclist keeps nvim's behaviour.
local function grove_goto(original, label)
  return function(opts)
    opts = opts or {}
    if opts.on_list ~= nil or opts.loclist then
      return original(opts)
    end
    local origin = {
      win = vim.api.nvim_get_current_win(),
      tagname = vim.fn.expand('<cword>'),
      from = vim.fn.getpos('.')
    }
    origin.from[1] = vim.api.nvim_get_current_buf()
    return original(vim.tbl_extend('force', opts, {
      on_list = function(list)
        if #list.items == 1 then
          grove_jump_to_location(list.items[1], origin)
          return
        end
        vim.rpcnotify(0, 'grove_locations', {
          label = label,
          symbol = origin.tagname,
          locations = vim.tbl_map(grove_location_from_item, list.items)
        })
      end
    }))
  end
end
vim.lsp.buf.definition = grove_goto(vim.lsp.buf.definition, 'Definitions')
vim.lsp.buf.declaration = grove_goto(vim.lsp.buf.declaration, 'Declarations')
vim.lsp.buf.type_definition = grove_goto(vim.lsp.buf.type_definition, 'Type definitions')
vim.lsp.buf.implementation = grove_goto(vim.lsp.buf.implementation, 'Implementations')
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(args)
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, {
      buffer = args.buf,
      desc = 'Go to definition'
    })
    vim.keymap.set('n', 'gD', vim.lsp.buf.declaration, {
      buffer = args.buf,
      desc = 'Go to declaration'
    })
    vim.keymap.set('n', 'gr', function()
      vim.rpcnotify(0, 'grove_references', { symbol = vim.fn.expand('<cword>') })
    end, {
      buffer = args.buf,
      desc = 'Go to references',
      -- Built-in LSP maps such as `grt` share this prefix. Grove deliberately
      -- owns exact `gr`, so do not wait for a third key before opening its picker.
      nowait = true
    })

    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client:supports_method('textDocument/inlayHint') then
      pcall(vim.lsp.inlay_hint.enable, true, { bufnr = args.buf })
    end
  end
})

-- LazyVim's habit: q closes a split that shows something other than a file —
-- git blame, help, quickfix, checkhealth, any plugin's nofile view — unless
-- its plugin already uses q. Decided by buftype, not a filetype list, so a
-- plugin grove doesn't know about gets it too. acwrite is left out: grove's
-- scratch and review buffers are written like files and edited as such.
local grove_view_buftypes = { nofile = true, nowrite = true, help = true, quickfix = true }

local function grove_map_close_with_q()
  if not grove_view_buftypes[vim.bo.buftype] then
    return
  end
  if vim.fn.maparg('q', 'n', false, true).buffer == 1 then
    return
  end
  -- pcall: the last window can't be closed (E444), and q then does nothing.
  vim.keymap.set('n', 'q', function()
    pcall(vim.cmd.close)
  end, { buffer = true, silent = true, desc = 'Close window' })
end

vim.api.nvim_create_autocmd({ 'BufWinEnter', 'FileType' }, {
  callback = grove_map_close_with_q
})

-- LazyVim's leader actions, as plain maps. Grove reads every <leader> map in
-- normal and visual mode and lists it in its own overlay under the which-key
-- group of its prefix, so these are rebindable in Keyboard Shortcuts like any
-- plugin's maps — nothing here is specific to grove.

--- Maps `<leader>` + keys in normal and visual mode.
local function leader(keys, action, desc)
  vim.keymap.set({ 'n', 'x' }, '<leader>' .. keys, action, { desc = desc })
end

--- Maps a UI toggle that reports which way it went.
local function toggle(keys, label, flip)
  vim.keymap.set('n', '<leader>' .. keys, function()
    local state = 'off'
    if flip() then
      state = 'on'
    end
    vim.notify(label .. ' ' .. state)
  end, { desc = 'Toggle ' .. label:lower() })
end

--- Flips a window option and returns its new value.
local function flipWindowOption(name)
  return function()
    vim.wo[name] = not vim.wo[name]
    return vim.wo[name]
  end
end

leader('ca', vim.lsp.buf.code_action, 'Code action')
leader('cA', function()
  vim.lsp.buf.code_action({ context = { only = { 'source' }, diagnostics = {} } })
end, 'Source action')
leader('co', function()
  vim.lsp.buf.code_action({ apply = true, context = { only = { 'source.organizeImports' }, diagnostics = {} } })
end, 'Organize imports')
leader('cr', vim.lsp.buf.rename, 'Rename')
leader('cf', function()
  require('conform').format({ lsp_format = 'fallback' })
end, 'Format')
leader('cc', vim.lsp.codelens.run, 'Run codelens')
leader('cC', function()
  vim.lsp.codelens.refresh({ bufnr = 0 })
end, 'Refresh and show codelens')
leader('cd', vim.diagnostic.open_float, 'Line diagnostics')
leader('cl', '<cmd>checkhealth vim.lsp<cr>', 'LSP info')
leader('cm', '<cmd>Mason<cr>', 'Mason')

leader('gb', function()
  require('gitsigns').blame_line({ full = true })
end, 'Blame line')
leader('ghs', function()
  require('gitsigns').stage_hunk()
end, 'Stage hunk')
leader('ghr', function()
  require('gitsigns').reset_hunk()
end, 'Reset hunk')
leader('ghS', function()
  require('gitsigns').stage_buffer()
end, 'Stage buffer')
leader('ghR', function()
  require('gitsigns').reset_buffer()
end, 'Reset buffer')
leader('ghp', function()
  require('gitsigns').preview_hunk_inline()
end, 'Preview hunk inline')
leader('ghB', function()
  require('gitsigns').blame()
end, 'Blame buffer')

-- LazyVim's other key for it: <leader>b is Grove's buffer group, run on its tabs.
vim.keymap.set('n', '<leader>`', '<cmd>buffer #<cr>', { desc = 'Switch to other buffer' })

toggle('uf', 'Format on save', function()
  vim.g.grove_autoformat = vim.g.grove_autoformat == false
  return vim.g.grove_autoformat
end)
toggle('us', 'Spelling', flipWindowOption('spell'))
toggle('uw', 'Wrap', flipWindowOption('wrap'))
toggle('ul', 'Line numbers', flipWindowOption('number'))
toggle('uL', 'Relative numbers', flipWindowOption('relativenumber'))
toggle('ud', 'Diagnostics', function()
  vim.diagnostic.enable(not vim.diagnostic.is_enabled())
  return vim.diagnostic.is_enabled()
end)
toggle('uh', 'Inlay hints', function()
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
    vim.rpcnotify(0, 'grove_keymap_changed', {})
  end)
end

vim.api.nvim_create_autocmd({ 'LspAttach', 'FileType' }, {
  callback = grove_notify_keymap_changed
})
vim.api.nvim_create_autocmd('User', {
  pattern = 'LazyLoad',
  callback = grove_notify_keymap_changed
})

-- Mix two "#rrggbb" colors; ratio 0 = base, 1 = tint. Used to derive subtle
-- diff line backgrounds from the saturated context colors.
local function blend(base, tint, ratio)
  local function channels(hex)
    local h = hex:gsub('#', '')
    return tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16)
  end
  local br, bg, bb = channels(base)
  local tr, tg, tb = channels(tint)
  local function mix(a, b)
    return math.floor(a + (b - a) * ratio + 0.5)
  end
  return string.format('#%02x%02x%02x', mix(br, tr), mix(bg, tg), mix(bb, tb))
end

-- Load Catppuccin as the code theme: Mocha on a dark app theme, Latte on a
-- light one. Its background shades are swapped for grove's, so the buffer sits
-- on the same surface as the panes around it whatever the app theme is.
-- Returns false when the plugin is not installed (first launch offline), and
-- the caller falls back to syntax colours derived from the app palette.
local function apply_code_theme(palette, scheme)
  local function hex(value)
    if type(value) == 'string' and value:match('^#%x%x%x%x%x%x$') then
      return value
    end
    return nil
  end
  local ok, catppuccin = pcall(require, 'catppuccin')
  if not ok then
    return false
  end
  local flavour = 'mocha'
  if scheme == 'light' then
    flavour = 'latte'
  end
  catppuccin.setup({
    flavour = flavour,
    color_overrides = {
      [flavour] = { base = hex(palette.surface), mantle = hex(palette.bgElevated), crust = hex(palette.bg) }
    },
    integrations = {
      blink_cmp = true,
      flash = true,
      gitsigns = true,
      illuminate = { enabled = true },
      mason = true,
      noice = true,
      snacks = { enabled = true, indent_scope_color = 'overlay2' },
      treesitter = true
    }
  })
  return pcall(vim.cmd.colorscheme, 'catppuccin-' .. flavour)
end

-- Syntax colours from the app palette's context colours, for when the code
-- theme could not be loaded.
local function apply_palette_syntax(palette)
  local set = vim.api.nvim_set_hl
  set(0, 'Visual', { bg = palette.borderStrong })
  set(0, 'LineNr', { fg = palette.textDim })
  set(0, 'CursorLine', { bg = palette.surfaceHover })
  set(0, 'CursorLineNr', { fg = palette.textMuted })
  set(0, 'Search', { fg = palette.textInverse, bg = palette.ctxAmber })
  set(0, 'IncSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'CurSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'MatchParen', { fg = palette.ctxAmber, bold = true })
  set(0, 'ErrorMsg', { fg = palette.ctxRed })
  set(0, 'WarningMsg', { fg = palette.ctxAmber })
  set(0, 'Question', { fg = palette.ctxGreen })
  set(0, 'Directory', { fg = palette.ctxBlue })
  set(0, 'Title', { fg = palette.ctxViolet, bold = true })
  set(0, 'NonText', { fg = palette.textFaint })
  set(0, 'Whitespace', { fg = palette.textFaint })
  -- Base syntax groups from the shared context colors.
  set(0, 'Comment', { fg = palette.textDim, italic = true })
  set(0, 'String', { fg = palette.ctxGreen })
  set(0, 'Number', { fg = palette.ctxAmber })
  set(0, 'Boolean', { fg = palette.ctxAmber })
  set(0, 'Constant', { fg = palette.ctxAmber })
  set(0, 'Identifier', { fg = palette.text })
  set(0, 'Function', { fg = palette.ctxBlue })
  set(0, 'Statement', { fg = palette.ctxViolet })
  set(0, 'Keyword', { fg = palette.ctxViolet })
  set(0, 'Operator', { fg = palette.textMuted })
  set(0, 'Type', { fg = palette.ctxBlue })
  set(0, 'PreProc', { fg = palette.ctxPink })
  set(0, 'Special', { fg = palette.ctxPink })
  set(0, 'Delimiter', { fg = palette.textMuted })
end

-- Same-token highlights are an underline and nothing else: no fill over the
-- code theme's, and no colour of their own, so the underline is drawn in the
-- colour of the token it sits under.
local function underline_same_token()
  for _, group in ipairs({ 'IlluminatedWordText', 'IlluminatedWordRead', 'IlluminatedWordWrite' }) do
    vim.api.nvim_set_hl(0, group, { underline = true })
  end
end

-- The groups that belong to grove's chrome rather than to the code: the
-- surfaces, floats and menus, the cursor, the diff fills the review flow paints
-- with, and the terminal colours. Applied last, over the code theme.
-- The editor sits in a pane next to grove's own panes, so it paints on the
-- surface pane background rather than the canvas underneath them; floats and
-- menus step up to the elevated level so they still read as raised.
local function apply_chrome(palette)
  local set = vim.api.nvim_set_hl
  set(0, 'Normal', { fg = palette.text, bg = palette.surface })
  set(0, 'NormalNC', { fg = palette.text, bg = palette.surface })
  set(0, 'NormalFloat', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'FloatBorder', { fg = palette.border, bg = palette.bgElevated })
  -- One fixed pair, not the colours of the cell underneath: the cursor has to
  -- be findable on a comment as easily as on a keyword.
  set(0, 'Cursor', { fg = palette.primaryFg, bg = palette.primary })
  set(0, 'lCursor', { fg = palette.primaryFg, bg = palette.primary })
  set(0, 'TermCursor', { fg = palette.primaryFg, bg = palette.primary })
  set(0, 'SignColumn', { bg = palette.surface })
  set(0, 'EndOfBuffer', { fg = palette.surface })
  set(0, 'WinSeparator', { fg = palette.border })
  set(0, 'Pmenu', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'PmenuSel', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'PmenuSbar', { bg = palette.bgElevated })
  set(0, 'PmenuThumb', { bg = palette.borderStrong })
  set(0, 'MsgArea', { fg = palette.textMuted, bg = palette.surface })
  -- Full-line diff fills: tint the base bg toward green/red so changed lines
  -- read at a glance without washing out the syntax-colored text on top.
  set(0, 'DiffAdd', { bg = blend(palette.surface, palette.ctxGreen, 0.22) })
  set(0, 'DiffDelete', { bg = blend(palette.surface, palette.ctxRed, 0.22) })
  set(0, 'DiffChange', { bg = blend(palette.surface, palette.ctxAmber, 0.22) })
  -- The debugger's gutter signs and the line execution stopped on (debug.lua).
  set(0, 'GroveBreakpoint', { fg = palette.ctxRed })
  set(0, 'GroveLogpoint', { fg = palette.ctxBlue })
  set(0, 'GroveBreakpointUnverified', { fg = palette.textDim })
  set(0, 'GroveBreakpointDisabled', { fg = palette.textDim })
  set(0, 'GroveDebugStopped', { fg = palette.ctxAmber })
  set(0, 'GroveDebugStoppedLine', { bg = blend(palette.surface, palette.ctxAmber, 0.18) })

  -- Terminal ANSI palette (0-15) dynamically bound to Grove's theme tokens
  vim.g.terminal_color_0 = palette.surface
  vim.g.terminal_color_1 = palette.ctxRed
  vim.g.terminal_color_2 = palette.ctxGreen
  vim.g.terminal_color_3 = palette.ctxAmber
  vim.g.terminal_color_4 = palette.ctxBlue
  vim.g.terminal_color_5 = palette.ctxViolet
  vim.g.terminal_color_6 = palette.ctxPink
  vim.g.terminal_color_7 = palette.textMuted
  vim.g.terminal_color_8 = palette.textDim
  vim.g.terminal_color_9 = palette.ctxRed
  vim.g.terminal_color_10 = palette.ctxGreen
  vim.g.terminal_color_11 = palette.ctxAmber
  vim.g.terminal_color_12 = palette.ctxBlue
  vim.g.terminal_color_13 = palette.ctxViolet
  vim.g.terminal_color_14 = palette.primary
  vim.g.terminal_color_15 = palette.text
end

-- Applied by grove over RPC (nvim_exec_lua) on attach and on every app theme
-- change: the code theme first, then grove's chrome over it. `palette` is a
-- subset of grove's ThemePalette (hex strings), `scheme` is 'dark' or 'light'.
_G.grove_apply_theme = function(palette, scheme)
  if apply_code_theme(palette, scheme) then
    underline_same_token()
  else
    apply_palette_syntax(palette)
  end
  apply_chrome(palette)
end

-- Grove can send its theme while this file is still running: nvim answers RPC
-- while lazy installs missing plugins above, before grove_apply_theme exists.
-- Grove leaves the theme in vim.g.grove_theme for exactly that case, and it is
-- applied here, once the plugins (and so the code theme) are in place.
if type(vim.g.grove_theme) == 'table' then
  _G.grove_apply_theme(vim.g.grove_theme.palette, vim.g.grove_theme.scheme)
end

-- Push the named code scopes enclosing the cursor (function/class/etc, outer
-- first) to grove's breadcrumb bar. Treesitter-based, so it works in any
-- buffer with a running parser; buffers without one report an empty chain.
local function grove_code_context()
  local ok, node = pcall(vim.treesitter.get_node)
  if not ok then
    return {}
  end
  local names = {}
  while node do
    local node_type = node:type()
    local is_scope = node_type:find('function')
      or node_type:find('method')
      or node_type:find('class')
      or node_type:find('interface')
      or node_type:find('struct')
      or node_type:find('enum')
      or node_type:find('module')
      or node_type:find('namespace')
      or node_type:find('impl')
    if is_scope then
      local name_node = node:field('name')[1]
      if name_node then
        table.insert(names, 1, vim.treesitter.get_node_text(name_node, 0))
      end
    elseif node_type == 'variable_declarator' then
      -- `const foo = () => …`: the arrow function itself is anonymous, its
      -- name lives on the declarator.
      local value = node:field('value')[1]
      local name_node = node:field('name')[1]
      if value and name_node and value:type():find('function') then
        table.insert(names, 1, vim.treesitter.get_node_text(name_node, 0))
      end
    end
    node = node:parent()
  end
  return names
end

local code_context_timer = nil
vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI', 'BufEnter' }, {
  callback = function()
    if code_context_timer then
      code_context_timer:stop()
    end
    code_context_timer = vim.defer_fn(function()
      vim.rpcnotify(0, 'grove_code_context', { names = grove_code_context() })
    end, 120)
  end
})

-- Prompt blame. When the cursor rests on a line, grove is told which; if an
-- agent wrote it, grove answers with grove_show_prompt_blame, which puts the
-- commit and the prompt that wrote the line at its end. Lines a person wrote
-- get nothing, and the text goes as soon as the cursor moves.
local prompt_blame_ns = vim.api.nvim_create_namespace('grove_prompt_blame')
local prompt_blame_timer = nil
local prompt_blame_buf = nil

--- The cursor line of a file buffer, as grove blames it; nil anywhere else.
local function grove_blame_context()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].buftype ~= '' then return nil end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' then return nil end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local text = vim.api.nvim_buf_get_lines(buf, line - 1, line, false)[1] or ''
  return { buf = buf, path = name, line = line, text = text }
end

local function clear_prompt_blame()
  if prompt_blame_buf and vim.api.nvim_buf_is_valid(prompt_blame_buf) then
    vim.api.nvim_buf_clear_namespace(prompt_blame_buf, prompt_blame_ns, 0, -1)
  end
  prompt_blame_buf = nil
end

vim.api.nvim_create_autocmd({ 'CursorMoved', 'BufEnter', 'InsertLeave' }, {
  group = vim.api.nvim_create_augroup('grove.prompt_blame', { clear = true }),
  callback = function()
    clear_prompt_blame()
    if prompt_blame_timer then prompt_blame_timer:stop() end
    prompt_blame_timer = vim.defer_fn(function()
      if vim.api.nvim_get_mode().mode ~= 'n' then return end
      local context = grove_blame_context()
      if context then vim.rpcnotify(0, 'grove_line_blame', context) end
    end, 400)
  end
})
vim.api.nvim_create_autocmd('InsertEnter', { group = 'grove.prompt_blame', callback = clear_prompt_blame })

--- Shows `label` at the end of `line`, if the cursor is still on it reading `text`.
_G.grove_show_prompt_blame = function(buf, line, text, label)
  if buf ~= vim.api.nvim_get_current_buf() or not vim.api.nvim_buf_is_valid(buf) then return end
  if vim.api.nvim_win_get_cursor(0)[1] ~= line then return end
  if (vim.api.nvim_buf_get_lines(buf, line - 1, line, false)[1] or '') ~= text then return end
  clear_prompt_blame()
  vim.api.nvim_buf_set_extmark(buf, prompt_blame_ns, line - 1, 0, {
    virt_text = { { '    ' .. label, 'GroveAgentMarkAnnotation' } },
    virt_text_pos = 'eol',
    hl_mode = 'combine',
  })
  prompt_blame_buf = buf
end

leader('gp', function()
  local context = grove_blame_context()
  if context then vim.rpcnotify(0, 'grove_open_line_prompt', context) end
end, 'Prompt that wrote this line')

-- Right-click menu. nvim would draw its PopUp menu as grid cells, which grove
-- renders but cannot make clickable, so right-click instead does what
-- 'mousemodel' popup_setpos does to the cursor, lets the MenuPopup autocmds
-- enable the entries that apply here, and hands the entries to grove to show
-- as a real menu. Grove answers with grove_run_popup_item.

-- The PopUp menu's mode for the current mode: visual, insert or normal.
local function popup_mode()
  local mode = vim.fn.mode()
  if mode:match('^[vV\22sS\19]') then
    return 'v'
  end
  if mode == 'i' then
    return 'i'
  end
  return 'n'
end

-- True when a mouse position falls inside the current visual selection.
local function inside_selection(mouse)
  local start_line = vim.fn.line('v')
  local end_line = vim.fn.line('.')
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end
  return mouse.line >= start_line and mouse.line <= end_line
end

-- Move the cursor to the clicked cell, leaving a visual selection alone when
-- the click lands inside it so its Cut/Copy entries act on it.
local function place_cursor_at_mouse(mouse, mode)
  if mouse.winid == 0 or mouse.line == 0 then
    return mode
  end
  if mode == 'v' and inside_selection(mouse) then
    return mode
  end
  if mode == 'v' then
    vim.cmd('normal! \27')
    mode = 'n'
  end
  vim.api.nvim_set_current_win(mouse.winid)
  pcall(vim.api.nvim_win_set_cursor, mouse.winid, { mouse.line, math.max(0, mouse.column - 1) })
  return mode
end

-- The PopUp entries for a mode, in menu order. A separator is `{ separator = true }`.
local function popup_items(mode)
  local items = {}
  for _, name in ipairs(vim.fn.menu_info('PopUp', mode).submenus or {}) do
    local entry = vim.fn.menu_info('PopUp.' .. name, mode)
    if name:match('^%-.*%-$') then
      items[#items + 1] = { separator = true }
    elseif entry.rhs ~= nil and entry.rhs ~= '' then
      items[#items + 1] = { name = name, enabled = entry.enabled ~= false and entry.enabled ~= 0 }
    end
  end
  return items
end

local function grove_right_click()
  local mode = place_cursor_at_mouse(vim.fn.getmousepos(), popup_mode())
  vim.api.nvim_exec_autocmds('MenuPopup', { pattern = mode, modeline = false })
  vim.rpcnotify(0, 'grove_popup_menu', { mode = mode, items = popup_items(mode) })
end

vim.keymap.set({ 'n', 'x', 'i' }, '<RightMouse>', grove_right_click, { desc = 'Right-click menu' })
-- The release would otherwise extend a selection to wherever the pointer is.
vim.keymap.set({ 'n', 'x', 'i' }, '<RightRelease>', '<Nop>')

-- vim.ui.select (code actions, and any plugin asking for a choice) opens
-- grove's picker instead of nvim's numbered inputlist, which grove can only
-- show as a blocking prompt. Grove answers through grove_ui_select_done.
local grove_ui_select_pending = {}
local grove_ui_select_next_id = 0

--- One select item as grove lists it. A code action the server offers but
--- can't apply here comes with the reason, so grove can list it apart instead
--- of burying the usable ones under "(disabled)" titles.
local function grove_ui_select_entry(item, opts)
  local action = type(item) == 'table' and item.action or nil
  if opts.kind == 'codeaction' and type(action) == 'table' and action.title then
    local entry = { label = action.title }
    if action.disabled then
      entry.disabled = action.disabled.reason or 'disabled'
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
  vim.rpcnotify(0, 'grove_ui_select', {
    id = grove_ui_select_next_id,
    prompt = opts.prompt,
    kind = opts.kind,
    items = entries
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

-- Previews nvim opens beside the cursor without entering (hover, line
-- diagnostics, Inspect) only close when the cursor moves. Escape in normal
-- mode closes them too, and clears the search highlight as LazyVim's does.
local function grove_close_previews()
  local current = vim.api.nvim_get_current_win()
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local config = vim.api.nvim_win_get_config(win)
    local preview = config.relative ~= '' and win ~= current and (config.zindex or 50) < 100
    if preview and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == 'nofile' then
      pcall(vim.api.nvim_win_close, win, false)
    end
  end
end
vim.keymap.set('n', '<Esc>', function()
  grove_close_previews()
  vim.cmd.nohlsearch()
end, { desc = 'Close previews and clear search highlight' })

-- :Inspect echoes its report, several lines long, so nvim stops on its
-- hit-enter prompt to show it. The menu's Inspect opens the same report as a
-- float at the cursor instead, gone when the cursor moves.
local function grove_inspect_float()
  local report = vim.api.nvim_exec2('Inspect', { output = true }).output
  local lines = vim.split(report, '\n', { trimempty = true })
  if #lines == 0 then
    return
  end
  vim.lsp.util.open_floating_preview(lines, '', { focus_id = 'grove_inspect' })
end
vim.api.nvim_create_user_command('GroveInspect', grove_inspect_float, { desc = 'Inspect in a float' })

-- nvim's MenuPopup autocmd only enables and disables entries, so redefining
-- this one sticks.
vim.cmd([[anoremenu PopUp.Inspect <Cmd>GroveInspect<CR>]])

-- Fix with Agent: on a line with diagnostics, the right-click menu hands them
-- to an agent. Grove lists the entry once per agent it could go to and reads
-- the problem through grove_fix_context; run from nvim's own :emenu, it goes to
-- grove as grove_fix_with_agent, for the worktree's agent.

-- The cursor line's diagnostics and the code `radius` lines either side of it,
-- or nil when the line has none.
_G.grove_fix_context = function(radius)
  local bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1] - 1
  local found = vim.diagnostic.get(bufnr, { lnum = line })
  if #found == 0 then
    return nil
  end
  local diagnostics = {}
  for _, d in ipairs(found) do
    diagnostics[#diagnostics + 1] = {
      lnum = d.lnum,
      col = d.col,
      severity = d.severity,
      message = d.message,
      source = d.source
    }
  end
  local first = math.max(0, line - radius)
  local last = math.min(vim.api.nvim_buf_line_count(bufnr), line + radius + 1)
  return {
    path = vim.api.nvim_buf_get_name(bufnr),
    diagnostics = diagnostics,
    startLine = first + 1,
    endLine = last,
    text = table.concat(vim.api.nvim_buf_get_lines(bufnr, first, last, false), '\n')
  }
end

_G.grove_fix_with_agent = function()
  local context = grove_fix_context(10)
  if context == nil then
    return
  end
  vim.rpcnotify(0, 'grove_fix_with_agent', context)
end

-- First in the menu: on a line with a problem, fixing it is the likeliest ask.
vim.cmd([[anoremenu .400 PopUp.Fix\ with\ Agent <Cmd>lua grove_fix_with_agent()<CR>]])
vim.cmd([[anoremenu .401 PopUp.-fix- <Nop>]])
vim.api.nvim_create_autocmd('MenuPopup', {
  group = vim.api.nvim_create_augroup('grove.fix_with_agent', {}),
  desc = 'Offer Fix with Agent on lines with diagnostics',
  callback = function()
    local line = vim.api.nvim_win_get_cursor(0)[1] - 1
    if #vim.diagnostic.get(0, { lnum = line }) > 0 then
      vim.cmd([[anoremenu enable PopUp.Fix\ with\ Agent]])
      return
    end
    vim.cmd([[anoremenu disable PopUp.Fix\ with\ Agent]])
  end
})

-- Each buffer's own snacks_scroll setting while a PopUp entry holds it off.
local grove_popup_scroll_setting = {}

-- Give a buffer its snacks.scroll setting back once a PopUp entry's keys are
-- done. Scheduled, so the WinScrolled the entry caused is seen while scrolling
-- is still off and the next scroll starts from where the entry left the view.
_G.grove_popup_item_done = function(buffer)
  vim.schedule(function()
    local setting = grove_popup_scroll_setting[buffer]
    grove_popup_scroll_setting[buffer] = nil
    if vim.api.nvim_buf_is_valid(buffer) then
      vim.b[buffer].snacks_scroll = setting
    end
  end)
end

-- Run the PopUp entry grove's menu picked, in the mode the menu was opened for.
-- snacks.scroll is held off while its keys run: it animates a jump by putting
-- the cursor back where it was and walking it over, so the V of Select All's
-- ggVG landed mid-walk and anchored the selection at the right-clicked line.
_G.grove_run_popup_item = function(name, mode)
  local entry = vim.fn.menu_info('PopUp.' .. name, mode)
  if entry.rhs == nil or entry.rhs == '' then
    return
  end
  local keys = vim.api.nvim_replace_termcodes(entry.rhs, true, false, true)
  local flags = 'm'
  if entry.noremenu then
    flags = 'n'
  end
  local buffer = vim.api.nvim_get_current_buf()
  grove_popup_scroll_setting[buffer] = vim.b[buffer].snacks_scroll
  vim.b[buffer].snacks_scroll = false
  vim.api.nvim_feedkeys(keys, flags, false)
  local done = ('<Cmd>lua grove_popup_item_done(%d)<CR>'):format(buffer)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(done, true, false, true), 'n', false)
end

-- A dependency-free popup terminal for exercising (and using) Grove's native
-- multigrid float surface. The terminal buffer and shell process survive while
-- the window is hidden; invoking the command again reopens the same session.
-- This deliberately uses nvim_open_win rather than a terminal plugin so the
-- feature remains available when lazy.nvim could not install anything offline.
local grove_terminal = { buf = nil, win = nil }

local function grove_terminal_geometry()
  local columns = vim.o.columns
  local lines = vim.o.lines
  local width = math.max(20, math.min(columns - 4, math.floor(columns * 0.78)))
  local height = math.max(6, math.min(lines - 4, math.floor(lines * 0.68)))
  return {
    relative = 'editor',
    row = math.floor((lines - height) / 2),
    col = math.floor((columns - width) / 2),
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded',
    title = ' Terminal ',
    title_pos = 'center',
  }
end

local function grove_popup_terminal()
  if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
    pcall(vim.api.nvim_win_close, grove_terminal.win, true)
    grove_terminal.win = nil
    return
  end

  if not grove_terminal.buf or not vim.api.nvim_buf_is_valid(grove_terminal.buf) then
    grove_terminal.buf = vim.api.nvim_create_buf(false, true)
    vim.bo[grove_terminal.buf].bufhidden = 'hide'
  end

  grove_terminal.win = vim.api.nvim_open_win(grove_terminal.buf, true, grove_terminal_geometry())
  vim.wo[grove_terminal.win].number = false
  vim.wo[grove_terminal.win].relativenumber = false
  vim.wo[grove_terminal.win].signcolumn = 'no'

  if vim.bo[grove_terminal.buf].buftype ~= 'terminal' then
    vim.api.nvim_buf_call(grove_terminal.buf, function()
      local shell = vim.env.SHELL
      if shell == nil or shell == '' then
        shell = vim.o.shell
      end
      if shell == nil or shell == '' then
        shell = '/bin/bash'
      end
      local cmd = vim.fn.has('win32') == 1 and shell or { shell, '-l', '-i' }
      local term_env = {
        XDG_CONFIG_HOME = vim.env.REAL_XDG_CONFIG_HOME or (vim.env.HOME .. '/.config'),
        XDG_DATA_HOME = vim.env.REAL_XDG_DATA_HOME or (vim.env.HOME .. '/.local/share'),
        XDG_STATE_HOME = vim.env.REAL_XDG_STATE_HOME or (vim.env.HOME .. '/.local/state'),
        XDG_CACHE_HOME = vim.env.REAL_XDG_CACHE_HOME or (vim.env.HOME .. '/.cache'),
      }
      vim.fn.termopen(cmd, {
        env = term_env,
        on_exit = function()
          if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
            pcall(vim.api.nvim_win_close, grove_terminal.win, true)
            grove_terminal.win = nil
          end
          if grove_terminal.buf and vim.api.nvim_buf_is_valid(grove_terminal.buf) then
            pcall(vim.api.nvim_buf_delete, grove_terminal.buf, { force = true })
            grove_terminal.buf = nil
          end
        end,
      })
    end)
    vim.keymap.set('t', '<Esc><Esc>', function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = 'Close popup terminal' })
    vim.keymap.set('t', '<C-w>q', function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = 'Close popup terminal' })
    vim.keymap.set('n', 'q', function()
      grove_popup_terminal()
    end, { buffer = grove_terminal.buf, desc = 'Close popup terminal' })
  end
  vim.cmd('startinsert')
end

vim.api.nvim_create_autocmd('WinClosed', {
  callback = function(args)
    if grove_terminal.win and tonumber(args.match) == grove_terminal.win then
      grove_terminal.win = nil
    end
  end,
})

vim.api.nvim_create_autocmd('VimResized', {
  callback = function()
    if grove_terminal.win and vim.api.nvim_win_is_valid(grove_terminal.win) then
      vim.api.nvim_win_set_config(grove_terminal.win, grove_terminal_geometry())
    end
  end,
})

vim.api.nvim_create_user_command('GroveTerminal', grove_popup_terminal, {
  desc = 'Toggle a terminal in a native Grove floating surface',
})
vim.keymap.set('n', '<leader>tt', grove_popup_terminal, {
  desc = 'Toggle popup terminal',
})

-- The debugger's breakpoints and stopped line, drawn from Grove's state, and
-- gutter clicks that toggle a breakpoint (see debug.lua).
_G.grove_debug = dofile(vim.fs.joinpath(configDir, 'debug.lua'))
_G.grove_debug.setup()

-- Sanctioned user-extension hook (Phase C): a writable init in nvim's data
-- dir (grove userData) is sourced last when present.
pcall(dofile, vim.fs.joinpath(vim.fn.stdpath('data'), 'user', 'init.lua'))
