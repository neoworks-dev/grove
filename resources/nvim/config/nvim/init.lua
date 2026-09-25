-- Grove-managed Neovim config for the embedded editor pane. Lives at
-- ~/.config/grove/nvim (XDG_CONFIG_HOME=~/.config/grove) — for now a symlink
-- to the bundled resources/nvim/config/nvim, so the user's own ~/.config/nvim
-- is never touched. Grove owns tabs and the statusline, so nvim's chrome is
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

-- Accepts the Copilot ghost-text suggestion currently on screen. Returns true
-- when it consumed the key, which is blink.cmp's signal to stop walking the
-- rest of its <Tab> fallback chain. Returns false when copilot.lua has not
-- loaded yet or has nothing to offer, so <Tab> keeps its normal meaning.
local function acceptCopilotSuggestion()
  local ok, suggestion = pcall(require, 'copilot.suggestion')
  if not ok then return false end
  if not suggestion.is_visible() then return false end
  suggestion.accept()
  return true
end

if (vim.uv or vim.loop).fs_stat(lazyEntry) then
  vim.opt.rtp:prepend(lazyPath)
  local installsPlugins = acquireInstallLock()
  pcall(function()
    require('lazy').setup({
      -- vim-sleuth: read a file's own indentation and set tabstop/shiftwidth/
      -- expandtab from it, so a tab-indented project keeps its tabs and a
      -- 4-space one keeps its four. No config, no keys — it just observes.
      { 'tpope/vim-sleuth' },

      -- The code theme. Not applied here: grove_apply_theme (below) sets it up
      -- with grove's own backgrounds and picks the flavour from the app's
      -- light/dark scheme, and re-runs whenever the app theme changes.
      { 'catppuccin/nvim', name = 'catppuccin', lazy = false, priority = 1000 },

      -- snacks.nvim, for two of its modules only: indent guides with the
      -- enclosing scope drawn brighter, and animated scrolling so a jump of a
      -- page (or a wheel notch) glides instead of snapping. Every other module
      -- stays off unless it is enabled here.
      {
        'folke/snacks.nvim',
        lazy = false,
        priority = 900,
        opts = {
          indent = { enabled = true },
          scroll = { enabled = true }
        }
      },

      -- Same-token highlighting: every other occurrence of the word under the
      -- cursor, from the LSP where one is attached and treesitter or a plain
      -- match otherwise. The underline is added in grove_apply_theme.
      {
        'RRethy/vim-illuminate',
        event = { 'BufReadPost', 'BufNewFile' },
        opts = {
          delay = 200,
          large_file_cutoff = 2000,
          large_file_overrides = { providers = { 'lsp' } }
        },
        config = function(_, opts)
          require('illuminate').configure(opts)
        end
      },

      -- noice.nvim, for the command line only: `:` and `/` open as a popup in
      -- the middle of the editor instead of on its last row. Messages stay in
      -- nvim's own message grid, because that is where grove recognises a
      -- blocking prompt (see blockingPrompt.ts); handing them to noice would
      -- leave a prompt no pane can see. Its LSP hover, signature and progress
      -- takeovers stay off — grove and blink already draw those.
      {
        'folke/noice.nvim',
        event = 'VeryLazy',
        dependencies = { 'MunifTanjim/nui.nvim' },
        opts = {
          cmdline = { enabled = true, view = 'cmdline_popup' },
          messages = { enabled = false },
          popupmenu = { enabled = true, backend = 'nui' },
          notify = { enabled = false },
          lsp = {
            progress = { enabled = false },
            hover = { enabled = false },
            signature = { enabled = false },
            message = { enabled = false }
          },
          presets = { command_palette = true }
        }
      },

      -- flash.nvim: quick label-based motion. `s`/`S` jump by on-screen labels.
      {
        'folke/flash.nvim',
        opts = {},
        keys = {
          { 's', mode = { 'n', 'x', 'o' }, function() require('flash').jump() end, desc = 'Flash' },
          { 'S', mode = { 'n', 'x', 'o' }, function() require('flash').treesitter() end, desc = 'Flash Treesitter' }
        }
      },

      -- Treesitter syntax highlighting. The `main` branch is the rewrite for
      -- nvim 0.11+ (our runtime is 0.12); the legacy `master` branch crashes on
      -- 0.12 (query-predicate handlers pass nil nodes → "call method 'range'").
      -- The main branch dropped the configs/ensure_installed API: install parsers
      -- explicitly and start the native highlighter per-buffer.
      {
        'nvim-treesitter/nvim-treesitter',
        branch = 'main',
        config = function()
          local ok, ts = pcall(require, 'nvim-treesitter')
          -- No 'jsonc': the main branch has no separate jsonc grammar (the json
          -- parser serves the jsonc filetype), so listing it warns "skipping
          -- unsupported language: jsonc".
          local parsers = {
            'typescript', 'tsx', 'javascript', 'json',
            'html', 'css', 'lua', 'vim', 'vimdoc', 'markdown', 'markdown_inline'
          }
          -- The main branch compiles parsers with the `tree-sitter` CLI (installed
          -- via mason below). Skip when it's absent so init never errors; the CLI
          -- lands async on first launch, so also retry when mason signals done.
          local function try_install()
            if ok and type(ts.install) == 'function' and vim.fn.executable('tree-sitter') == 1 then
              pcall(ts.install, parsers)
            end
          end
          try_install()
          vim.api.nvim_create_autocmd('User', {
            pattern = 'MasonToolsUpdateCompleted',
            callback = try_install
          })
          vim.api.nvim_create_autocmd('FileType', {
            callback = function(args)
              pcall(vim.treesitter.start, args.buf)
            end
          })
        end
      },

      -- Git gutter signs (added/changed/removed) in the sign column. Rendered
      -- in-grid; hunk staging/preview available as keymaps.
      { 'lewis6991/gitsigns.nvim', opts = {} },

      -- which-key.nvim for its group specs only: grove draws the leader overlay
      -- itself and names each prefix from the groups registered here, by this
      -- config or any plugin. No triggers and no presets, so which-key never
      -- maps a key or opens its own popup.
      {
        'folke/which-key.nvim',
        lazy = false,
        opts = {
          triggers = {},
          plugins = {
            marks = false,
            registers = false,
            spelling = { enabled = false },
            presets = {
              operators = false,
              motions = false,
              text_objects = false,
              windows = false,
              nav = false,
              z = false,
              g = false
            }
          },
          spec = {
            {
              mode = { 'n', 'x' },
              { '<leader>b', group = 'buffer' },
              { '<leader>c', group = 'code' },
              { '<leader>f', group = 'file/find' },
              { '<leader>g', group = 'git' },
              { '<leader>gh', group = 'hunks' },
              { '<leader>s', group = 'search' },
              { '<leader>t', group = 'terminal' },
              { '<leader>u', group = 'ui' },
              { '<leader>w', group = 'windows' },
              { '<leader>x', group = 'diagnostics/quickfix' }
            }
          }
        }
      },

      -- Completion engine. blink.cmp ships a prebuilt fuzzy-matcher binary via
      -- its release tag and falls back to a Lua matcher when the download is
      -- unavailable, so it stays offline-tolerant like the rest of the config.
      {
        'saghen/blink.cmp',
        version = '*',
        opts = {
          -- 'enter' preset: <CR> accepts the selected item and is consumed, so
          -- accepting never also inserts a newline ('default' leaves <CR> unmapped).
          -- <Esc> with the menu open only closes the menu (staying in insert);
          -- without a menu it falls through to the normal mode switch.
          -- <Tab> is shared with Copilot. Owning it in one place (rather than
          -- letting copilot.lua install its own insert-mode map) keeps either
          -- plugin from silently swallowing the key from the other: a visible
          -- ghost-text suggestion wins, then blink's snippet jump, then a
          -- literal tab.
          keymap = {
            preset = 'enter',
            ['<Esc>'] = { 'cancel', 'fallback' },
            ['<Tab>'] = { acceptCopilotSuggestion, 'snippet_forward', 'fallback' }
          },
          sources = { default = { 'lsp', 'path', 'snippets', 'buffer' } },
          completion = {
            -- Suggestions stay below the edited text. A single direction also
            -- prevents blink from preferring the roomier side above the cursor.
            menu = { direction_priority = { 's' } },
            documentation = {
              auto_show = true,
              -- A tall documentation float otherwise aligns itself with the
              -- menu by growing upward across the line being edited.
              window = {
                direction_priority = {
                  menu_north = { 's' },
                  menu_south = { 's' }
                }
              }
            }
          }
        }
      },

      -- GitHub Copilot as inline ghost text. Deliberately not wired as a
      -- blink.cmp source: the suggestion renders as virtual text after the
      -- cursor, so the completion menu stays LSP/path/snippet/buffer only and
      -- never lists the same completion twice.
      --
      -- Auth lives at $XDG_CONFIG_HOME/github-copilot. Grove points
      -- XDG_CONFIG_HOME at ~/.config/grove and links that subdirectory to the
      -- user's real ~/.config/github-copilot (see src/main/nvimPaths.ts), so an
      -- existing Copilot login carries over. Without one, `:Copilot auth` once
      -- in any editor pane signs in.
      {
        'zbirenbaum/copilot.lua',
        event = 'InsertEnter',
        opts = {
          suggestion = {
            enabled = true,
            auto_trigger = true,
            -- No accept mapping here: blink.cmp owns <Tab> and calls into
            -- copilot.suggestion from its fallback chain (see above).
            keymap = {
              accept = false,
              accept_word = false,
              accept_line = false,
              next = '<M-]>',
              prev = '<M-[>',
              dismiss = '<C-]>'
            }
          },
          -- The Copilot panel opens its own split; grove owns the layout.
          panel = { enabled = false },
          -- copilot.lua disables prose filetypes by default. Grove edits docs
          -- and config in the same panes as code, so re-enable the useful ones.
          filetypes = { markdown = true, yaml = true, gitcommit = true }
        }
      },

      -- Format-on-save via conform. Prefers the fast daemonized prettier, falls
      -- back to prettier, then to the LSP formatter.
      {
        'stevearc/conform.nvim',
        opts = {
          formatters_by_ft = {
            lua = { 'stylua' },
            javascript = { 'prettierd', 'prettier', stop_after_first = true },
            javascriptreact = { 'prettierd', 'prettier', stop_after_first = true },
            typescript = { 'prettierd', 'prettier', stop_after_first = true },
            typescriptreact = { 'prettierd', 'prettier', stop_after_first = true },
            json = { 'prettierd', 'prettier', stop_after_first = true },
            css = { 'prettierd', 'prettier', stop_after_first = true },
            scss = { 'prettierd', 'prettier', stop_after_first = true },
            html = { 'prettierd', 'prettier', stop_after_first = true },
            markdown = { 'prettierd', 'prettier', stop_after_first = true },
            yaml = { 'prettierd', 'prettier', stop_after_first = true },
            -- Svelte needs prettier-plugin-svelte, which prettier picks up from
            -- the project being edited; without this entry .svelte buffers had
            -- no formatter at all and format-on-save silently did nothing.
            svelte = { 'prettierd', 'prettier', stop_after_first = true }
          },
          -- Grove's <leader>uf flips vim.g.grove_autoformat to false to pause it.
          format_on_save = function()
            if vim.g.grove_autoformat == false then
              return nil
            end
            return { timeout_ms = 1000, lsp_format = 'fallback' }
          end
        }
      },

      -- Linting via nvim-lint. Feeds vim.diagnostic, which is what grove's
      -- Diagnostics pane displays.
      {
        'mfussenegger/nvim-lint',
        config = function()
          require('lint').linters_by_ft = {
            javascript = { 'eslint_d' },
            javascriptreact = { 'eslint_d' },
            typescript = { 'eslint_d' },
            typescriptreact = { 'eslint_d' }
          }
          vim.api.nvim_create_autocmd({ 'BufWritePost', 'BufReadPost', 'InsertLeave' }, {
            callback = function()
              require('lint').try_lint()
            end
          })
        end
      },

      -- LSP: mason installs the servers into the writable data dir,
      -- mason-lspconfig enables them through nvim's built-in LSP registry.
      { 'williamboman/mason.nvim', opts = {} },

      -- Install the external formatter/linter binaries conform and nvim-lint
      -- shell out to (mason-lspconfig only handles LSP servers).
      {
        'WhoIsSethDaniel/mason-tool-installer.nvim',
        dependencies = { 'williamboman/mason.nvim' },
        opts = {
          -- tree-sitter-cli: required by nvim-treesitter (main) to build parsers.
          ensure_installed = { 'prettierd', 'eslint_d', 'stylua', 'tree-sitter-cli' }
        }
      },
      {
        'williamboman/mason-lspconfig.nvim',
        dependencies = { 'williamboman/mason.nvim', 'neovim/nvim-lspconfig', 'saghen/blink.cmp' },
        opts = {
          ensure_installed = { 'vtsls' },
          automatic_installation = true,
          -- vtsls is the TypeScript server here. mason-lspconfig enables every
          -- installed server, so a leftover ts_ls install would attach to the
          -- same buffers — two tsservers indexing the project, doubled
          -- diagnostics and completions.
          automatic_enable = { exclude = { 'ts_ls' } }
        },
        config = function(_, opts)
          require('mason').setup()
          -- Advertise blink.cmp's completion capabilities to every server.
          local ok, blink = pcall(require, 'blink.cmp')
          if ok then
            vim.lsp.config('*', { capabilities = blink.get_lsp_capabilities() })
          end
          -- vtsls reports inlay hints only for the categories asked for; without
          -- these it advertises the capability and returns nothing.
          local inlay_hints = {
            parameterNames = { enabled = 'literals', suppressWhenArgumentMatchesName = true },
            parameterTypes = { enabled = true },
            variableTypes = { enabled = true, suppressWhenTypeMatchesName = true },
            propertyDeclarationTypes = { enabled = true },
            functionLikeReturnTypes = { enabled = true },
            enumMemberValues = { enabled = true }
          }
          vim.lsp.config('vtsls', {
            settings = {
              typescript = { inlayHints = inlay_hints },
              javascript = { inlayHints = inlay_hints }
            }
          })
          require('mason-lspconfig').setup(opts)
          -- Belt-and-suspenders on nvim 0.11+: enable the server explicitly in
          -- case mason-lspconfig's automatic enable is unavailable.
          pcall(vim.lsp.enable, 'vtsls')
        end
      }
    }, {
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

vim.keymap.set('n', '<leader>bb', '<cmd>buffer #<cr>', { desc = 'Switch to other buffer' })

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

-- Previews go to grove, which draws them at the cursor the way an nvim float
-- looks: hover docs, signature help, Inspect and any plugin preview through
-- open_floating_preview (markdown rendered, code highlighted by nvim's own
-- treesitter and colours), and a line's diagnostics with the quick fixes the
-- servers offer, clickable. nvim keeps the lifecycle: the preview's close
-- events and Escape end it here, and grove asks back through
-- grove_preview_dismiss and grove_preview_apply_fix. Windows opened directly
-- with nvim_open_win are untouched.
local grove_preview = { id = 0, open = false, fixes = {}, buf = nil, focus_id = nil }
local grove_preview_group = vim.api.nvim_create_augroup('GrovePreview', { clear = true })

-- The cursor's screen cell, 0-based, where grove anchors the popover.
local function grove_cursor_cell()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local position = vim.fn.screenpos(0, cursor[1], cursor[2] + 1)
  return position.row - 1, position.col - 1
end

-- Ends the preview on grove's side.
local function grove_close_preview()
  vim.api.nvim_clear_autocmds({ group = grove_preview_group })
  if not grove_preview.open then
    return
  end
  grove_preview.open = false
  grove_preview.fixes = {}
  grove_preview.focus_id = nil
  vim.rpcnotify(0, 'grove_preview_close', { id = grove_preview.id })
end

-- Hands grove one preview and arms the events that end it. Returns its id.
local function grove_show_preview(message, close_events)
  grove_close_preview()
  grove_preview.id = grove_preview.id + 1
  grove_preview.open = true
  message.id = grove_preview.id
  message.row, message.col = grove_cursor_cell()
  vim.rpcnotify(0, 'grove_preview', message)
  local events = vim.list_extend({ 'BufLeave', 'WinLeave' }, close_events)
  -- Scheduled so the cursor move that opened the preview (a right-click
  -- places the cursor first) doesn't close it straight away.
  vim.schedule(function()
    if grove_preview.id ~= message.id then
      return
    end
    vim.api.nvim_create_autocmd(events, {
      group = grove_preview_group,
      buffer = vim.api.nvim_get_current_buf(),
      once = true,
      callback = grove_close_preview,
    })
  end)
  return grove_preview.id
end

-- A hidden buffer holding the preview's text, for callers that decorate the
-- buffer open_floating_preview returns (signature help highlights it).
local function grove_preview_buffer(lines)
  if grove_preview.buf == nil or not vim.api.nvim_buf_is_valid(grove_preview.buf) then
    grove_preview.buf = vim.api.nvim_create_buf(false, true)
  end
  vim.api.nvim_buf_set_lines(grove_preview.buf, 0, -1, false, lines)
  return grove_preview.buf
end

local grove_default_close_events = { 'CursorMoved', 'CursorMovedI', 'InsertCharPre' }

-- Colours of an nvim highlight group as grove paints them: hex fg, and the
-- attributes that change a glyph. A dotted treesitter group falls back to its
-- parent (@keyword.typescript → @keyword) the way nvim resolves it.
local function grove_group_style(group, cache)
  if cache[group] then
    return cache[group]
  end
  local name = group
  local found = {}
  while name do
    local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
    if ok and hl and next(hl) then
      found = hl
      break
    end
    name = name:match('^(.*)%.[^.]+$')
  end
  local style = { bold = found.bold == true, italic = found.italic == true, underline = found.underline == true }
  if found.fg then
    style.fg = string.format('#%06x', found.fg)
  end
  if found.bg then
    style.bg = string.format('#%06x', found.bg)
  end
  cache[group] = style
  return style
end

-- The colours grove needs to draw a preview as nvim would: the float's text and
-- background, the markdown elements, and each diagnostic severity.
local function grove_preview_theme()
  local cache = {}
  local function fg(group)
    return grove_group_style(group, cache).fg
  end
  local float = grove_group_style('NormalFloat', cache)
  local normal = grove_group_style('Normal', cache)
  return {
    fg = float.fg or normal.fg,
    bg = float.bg or normal.bg,
    heading = fg('@markup.heading'),
    strong = fg('@markup.strong'),
    raw = fg('@markup.raw.markdown_inline') or fg('@markup.raw'),
    link = fg('@markup.link.url') or fg('@markup.link'),
    quote = fg('@markup.quote') or fg('Comment'),
    dim = fg('Comment'),
    error = fg('DiagnosticError'),
    warn = fg('DiagnosticWarn'),
    info = fg('DiagnosticInfo'),
    hint = fg('DiagnosticHint'),
  }
end

-- Marks the cells a capture covers with its group, later captures winning, as
-- nvim layers them.
local function grove_mark_capture(styles, lines, node, group)
  local start_row, start_col, end_row, end_col = node:range()
  for row = start_row, end_row do
    local line = lines[row + 1] or ''
    local from = 0
    local to = #line
    if row == start_row then
      from = start_col
    end
    if row == end_row then
      to = end_col
    end
    styles[row] = styles[row] or {}
    for col = from, to - 1 do
      styles[row][col] = group
    end
  end
end

-- Runs nvim's treesitter highlighting (injections included) over a code block
-- and returns the highlight group of every cell, by row and 0-based column.
local function grove_code_groups(lines, lang)
  local styles = {}
  local code = table.concat(lines, '\n')
  local parser_lang = vim.treesitter.language.get_lang(lang) or lang
  local ok, parser = pcall(vim.treesitter.get_string_parser, code, parser_lang)
  if not ok or parser == nil then
    return styles
  end
  pcall(parser.parse, parser, true)
  parser:for_each_tree(function(tree, language_tree)
    local tree_lang = language_tree:lang()
    local query = vim.treesitter.query.get(tree_lang, 'highlights')
    if query == nil then
      return
    end
    for id, node in query:iter_captures(tree:root(), code) do
      local capture = query.captures[id]
      if not capture:match('^_') and capture ~= 'spell' and capture ~= 'nospell' and capture ~= 'conceal' then
        grove_mark_capture(styles, lines, node, '@' .. capture .. '.' .. tree_lang)
      end
    end
  end)
  return styles
end

-- One line of a code block as runs of equally styled text.
local function grove_line_runs(line, groups, cache)
  local runs = {}
  local start = 0
  while start < #line do
    local group = groups[start]
    local stop = start + 1
    while stop < #line and groups[stop] == group do
      stop = stop + 1
    end
    local run = { text = line:sub(start + 1, stop) }
    if group then
      local style = grove_group_style(group, cache)
      run.fg, run.bold, run.italic, run.underline = style.fg, style.bold, style.italic, style.underline
    end
    runs[#runs + 1] = run
    start = stop
  end
  return runs
end

-- A code block with nvim's highlighting, as lines of styled runs.
local function grove_code_block(lines, lang)
  local groups = grove_code_groups(lines, lang)
  local cache = {}
  local styled = {}
  for row, line in ipairs(lines) do
    styled[row] = grove_line_runs(line, groups[row - 1] or {}, cache)
  end
  return { kind = 'code', lines = styled }
end

-- Splits markdown into prose and fenced code, each fence highlighted by nvim.
local function grove_markdown_blocks(lines)
  local blocks = {}
  local prose = {}
  local fence = nil
  local function flush_prose()
    if #prose > 0 then
      blocks[#blocks + 1] = { kind = 'markdown', text = table.concat(prose, '\n') }
      prose = {}
    end
  end
  for _, line in ipairs(lines) do
    local opening = line:match('^%s*```+%s*([%w_+#.-]*)%s*$')
    if fence == nil and opening then
      flush_prose()
      fence = { lang = opening, lines = {} }
    elseif fence and line:match('^%s*```+%s*$') then
      blocks[#blocks + 1] = grove_code_block(fence.lines, fence.lang)
      fence = nil
    elseif fence then
      fence.lines[#fence.lines + 1] = line
    else
      prose[#prose + 1] = line
    end
  end
  if fence then
    blocks[#blocks + 1] = grove_code_block(fence.lines, fence.lang)
  end
  flush_prose()
  return blocks
end

-- A preview's contents as grove draws them: markdown with highlighted fences,
-- code in another syntax highlighted whole, anything else as plain text.
local function grove_preview_blocks(contents, syntax)
  if syntax == 'markdown' then
    return grove_markdown_blocks(contents)
  end
  if syntax == nil or syntax == '' or syntax == 'plaintext' then
    return { { kind = 'text', text = table.concat(contents, '\n') } }
  end
  return { grove_code_block(contents, syntax) }
end

local grove_original_open_floating_preview = vim.lsp.util.open_floating_preview
vim.lsp.util.open_floating_preview = function(contents, syntax, opts)
  opts = opts or {}
  -- An empty editor-relative float is a window to fill (checkhealth's), not a
  -- preview.
  if #contents == 0 or opts.relative == 'editor' then
    return grove_original_open_floating_preview(contents, syntax, opts)
  end
  -- A second K (the same focus_id while it is open) moves the keyboard into the
  -- preview, as nvim's own float does.
  local wants_focus = opts.focus ~= false and opts.focusable ~= false
  if wants_focus and opts.focus_id and grove_preview.open and grove_preview.focus_id == opts.focus_id then
    vim.rpcnotify(0, 'grove_preview_focus', { id = grove_preview.id })
    return grove_preview.buf, nil
  end
  local message = { kind = 'doc', blocks = grove_preview_blocks(contents, syntax), theme = grove_preview_theme() }
  grove_show_preview(message, opts.close_events or grove_default_close_events)
  grove_preview.focus_id = opts.focus_id
  return grove_preview_buffer(contents), nil
end

-- The LSP form of the line's diagnostics a client published, for its
-- codeAction request's context.
local function grove_lsp_diagnostics(diagnostics, client_id)
  local namespace = vim.lsp.diagnostic.get_namespace(client_id)
  local lsp = {}
  for _, diagnostic in ipairs(diagnostics) do
    local original = vim.tbl_get(diagnostic, 'user_data', 'lsp')
    if diagnostic.namespace == namespace and original then
      lsp[#lsp + 1] = original
    end
  end
  return lsp
end

-- Asks every attached server for the line's quick fixes and sends grove their
-- titles once all have answered. Kept here, per preview, to apply by index.
local function grove_request_fixes(id, bufnr, line, diagnostics)
  local clients = vim.lsp.get_clients({ bufnr = bufnr, method = 'textDocument/codeAction' })
  local fixes = {}
  local pending = #clients
  local function finish()
    if grove_preview.id ~= id or not grove_preview.open then
      return
    end
    grove_preview.fixes = fixes
    local titles = {}
    for index, fix in ipairs(fixes) do
      titles[index] = fix.action.title
    end
    vim.rpcnotify(0, 'grove_preview_fixes', { id = id, fixes = titles })
  end
  if pending == 0 then
    return finish()
  end
  local line_text = vim.api.nvim_buf_get_lines(bufnr, line, line + 1, false)[1] or ''
  for _, client in ipairs(clients) do
    local params = {
      textDocument = vim.lsp.util.make_text_document_params(bufnr),
      range = { start = { line = line, character = 0 }, ['end'] = { line = line, character = #line_text } },
      context = { diagnostics = grove_lsp_diagnostics(diagnostics, client.id), only = { 'quickfix' }, triggerKind = 1 },
    }
    client:request('textDocument/codeAction', params, function(_, result)
      for _, action in ipairs(result or {}) do
        if not action.disabled then
          fixes[#fixes + 1] = { client_id = client.id, action = action, bufnr = bufnr }
        end
      end
      pending = pending - 1
      if pending == 0 then
        finish()
      end
    end, bufnr)
  end
end

-- Applies a code action: its edit, then its command. A bare Command is its own
-- command.
local function grove_apply_action(client, action, bufnr)
  if action.edit then
    vim.lsp.util.apply_workspace_edit(action.edit, client.offset_encoding)
  end
  local command = action.command
  if type(command) == 'string' then
    command = action
  end
  if type(command) == 'table' then
    client:exec_cmd(command, { bufnr = bufnr })
  end
end

-- Resolves a lazily-filled action first when the server supports it.
local function grove_resolve_and_apply(fix)
  local client = vim.lsp.get_client_by_id(fix.client_id)
  if client == nil then
    return
  end
  if fix.action.edit or not client:supports_method('codeAction/resolve') then
    return grove_apply_action(client, fix.action, fix.bufnr)
  end
  client:request('codeAction/resolve', fix.action, function(err, resolved)
    if err then
      vim.notify(err.message, vim.log.levels.WARN)
      return
    end
    grove_apply_action(client, resolved or fix.action, fix.bufnr)
  end, fix.bufnr)
end

_G.grove_preview_apply_fix = function(id, index)
  if id ~= grove_preview.id then
    return
  end
  local fix = grove_preview.fixes[index]
  grove_close_preview()
  if fix == nil then
    return
  end
  vim.schedule(function()
    grove_resolve_and_apply(fix)
  end)
end

_G.grove_preview_dismiss = function(id)
  if id == grove_preview.id then
    grove_close_preview()
  end
end

-- One diagnostic as grove lists it.
local function grove_diagnostic_entry(diagnostic)
  local code = diagnostic.code
  if code ~= nil then
    code = tostring(code)
  end
  return { severity = diagnostic.severity, message = diagnostic.message, source = diagnostic.source, code = code }
end

-- The line's (or, for scope = 'cursor', the cursor's) diagnostics, worst first.
local function grove_float_diagnostics(bufnr, opts)
  local line = vim.api.nvim_win_get_cursor(0)[1] - 1
  local column = vim.api.nvim_win_get_cursor(0)[2]
  if opts.pos then
    line, column = opts.pos[1], opts.pos[2]
  end
  local diagnostics = vim.diagnostic.get(bufnr, { lnum = line, severity = opts.severity })
  if opts.scope == 'cursor' then
    diagnostics = vim.tbl_filter(function(diagnostic)
      return diagnostic.col <= column and column <= (diagnostic.end_col or diagnostic.col)
    end, diagnostics)
  end
  table.sort(diagnostics, function(left, right)
    return left.severity < right.severity
  end)
  return line, diagnostics
end

local grove_original_open_float = vim.diagnostic.open_float
vim.diagnostic.open_float = function(opts, ...)
  -- The old (bufnr, opts) form and buffer-wide scope keep nvim's own float.
  if (opts ~= nil and type(opts) ~= 'table') or (opts and opts.scope == 'buffer') then
    return grove_original_open_float(opts, ...)
  end
  opts = opts or {}
  -- Pressed again while open: move the keyboard into it, as nvim's float does.
  local focus_id = opts.focus_id or opts.scope or 'line'
  if opts.focus ~= false and grove_preview.open and grove_preview.focus_id == focus_id then
    vim.rpcnotify(0, 'grove_preview_focus', { id = grove_preview.id })
    return grove_preview.buf, nil
  end
  local bufnr = vim.api.nvim_get_current_buf()
  if opts.bufnr and opts.bufnr ~= 0 then
    bufnr = opts.bufnr
  end
  local line, diagnostics = grove_float_diagnostics(bufnr, opts)
  if #diagnostics == 0 then
    return
  end
  local entries = vim.tbl_map(grove_diagnostic_entry, diagnostics)
  local message = { kind = 'diagnostics', diagnostics = entries, theme = grove_preview_theme() }
  local id = grove_show_preview(message, opts.close_events or grove_default_close_events)
  grove_preview.focus_id = focus_id
  grove_request_fixes(id, bufnr, line, diagnostics)
  return grove_preview_buffer(vim.tbl_map(function(entry) return entry.message end, entries)), nil
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
  grove_close_preview()
  grove_close_previews()
  vim.cmd.nohlsearch()
end, { desc = 'Close previews and clear search highlight' })

-- A preview float the keyboard went into (a plugin's, entered with its own
-- key) closes on Escape too, not only q, so it never traps the cursor.
vim.api.nvim_create_autocmd('WinEnter', {
  callback = function()
    local win = vim.api.nvim_get_current_win()
    local buffer = vim.api.nvim_get_current_buf()
    if vim.api.nvim_win_get_config(win).relative == '' or vim.bo[buffer].buftype ~= 'nofile' then
      return
    end
    if vim.fn.maparg('<Esc>', 'n', false, true).buffer == 1 then
      return
    end
    vim.keymap.set('n', '<Esc>', function()
      pcall(vim.api.nvim_win_close, win, false)
    end, { buffer = buffer, desc = 'Close this float' })
  end
})

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

-- Run the PopUp entry grove's menu picked, in the mode the menu was opened for.
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
  vim.api.nvim_feedkeys(keys, flags, false)
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

-- Sanctioned user-extension hook (Phase C): a writable init in nvim's data
-- dir (grove userData) is sourced last when present.
pcall(dofile, vim.fs.joinpath(vim.fn.stdpath('data'), 'user', 'init.lua'))
