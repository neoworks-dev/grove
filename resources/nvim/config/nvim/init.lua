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
    uv.fs_rename(staging, lazyPath)
  end
  vim.fn.delete(staging, 'rf')
end

if not (vim.uv or vim.loop).fs_stat(lazyEntry) then
  bootstrapLazy()
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
          format_on_save = { timeout_ms = 1000, lsp_format = 'fallback' }
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
      install = { colorscheme = {} },
      ui = { border = 'rounded' },
      change_detection = { enabled = false }
    })
  end)
end

-- Each diagnostic's message at the end of its line, in the severity's colour
-- behind a dot, on top of the underline. Worst first where several share a line.
vim.diagnostic.config({
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  virtual_text = { spacing = 4, source = 'if_many', prefix = '●' }
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

-- Same-token highlights get an underline on top of whatever fill the code
-- theme gave them, so the other occurrences stand out on a busy line.
local function underline_same_token()
  for _, group in ipairs({ 'IlluminatedWordText', 'IlluminatedWordRead', 'IlluminatedWordWrite' }) do
    local highlight = vim.api.nvim_get_hl(0, { name = group, link = false })
    highlight.underline = true
    vim.api.nvim_set_hl(0, group, highlight)
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
