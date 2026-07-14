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
-- No swapfiles: every grove pane is its own embedded nvim, so two panes editing
-- the same file would collide on a swapfile and trigger a blocking E325 ATTENTION
-- prompt on attach (which aborts the session). Grove owns buffer persistence.
vim.opt.swapfile = false
vim.opt.mouse = 'a'
-- Keep 4 context lines visible above/below the cursor when scrolling.
vim.opt.scrolloff = 4
-- Also suppress the swap/attention message class outright as a belt-and-suspenders.
vim.opt.shortmess:append('IA')
vim.opt.fillchars = { eob = ' ' }

-- Plugin manager bootstrap. lazy.nvim clones itself and the declared plugins
-- into the writable data dir (XDG_DATA_HOME → grove userData) on first launch;
-- the user's own nvim install is untouched. Offline-tolerant: a failed clone
-- just leaves the editor plugin-less.
local dataDir = vim.fn.stdpath('data')
local lazyPath = vim.fs.joinpath(dataDir, 'lazy', 'lazy.nvim')
if not (vim.uv or vim.loop).fs_stat(lazyPath) then
  vim.fn.system({
    'git', 'clone', '--filter=blob:none', '--branch=stable',
    'https://github.com/folke/lazy.nvim.git', lazyPath
  })
end

if (vim.uv or vim.loop).fs_stat(lazyPath) then
  vim.opt.rtp:prepend(lazyPath)
  pcall(function()
    require('lazy').setup({
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
          local parsers = {
            'typescript', 'tsx', 'javascript', 'json', 'jsonc',
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
          keymap = { preset = 'default' },
          sources = { default = { 'lsp', 'path', 'snippets', 'buffer' } },
          completion = { documentation = { auto_show = true } }
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
            html = { 'prettierd', 'prettier', stop_after_first = true },
            markdown = { 'prettierd', 'prettier', stop_after_first = true }
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
          automatic_installation = true
        },
        config = function(_, opts)
          require('mason').setup()
          -- Advertise blink.cmp's completion capabilities to every server.
          local ok, blink = pcall(require, 'blink.cmp')
          if ok then
            vim.lsp.config('*', { capabilities = blink.get_lsp_capabilities() })
          end
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

-- Applied by grove over RPC (nvim_exec_lua) on create and on theme change.
-- `palette` is a subset of grove's ThemePalette: hex strings.
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

_G.grove_apply_theme = function(palette)
  local set = vim.api.nvim_set_hl
  set(0, 'Normal', { fg = palette.text, bg = palette.bg })
  set(0, 'NormalNC', { fg = palette.text, bg = palette.bg })
  set(0, 'NormalFloat', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'FloatBorder', { fg = palette.border, bg = palette.bgElevated })
  set(0, 'Visual', { bg = palette.surfaceHover })
  set(0, 'LineNr', { fg = palette.textDim })
  set(0, 'CursorLine', { bg = palette.surface })
  set(0, 'CursorLineNr', { fg = palette.textMuted })
  set(0, 'SignColumn', { bg = palette.bg })
  set(0, 'EndOfBuffer', { fg = palette.bg })
  set(0, 'WinSeparator', { fg = palette.border })
  set(0, 'Pmenu', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'PmenuSel', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'PmenuSbar', { bg = palette.surface })
  set(0, 'PmenuThumb', { bg = palette.borderStrong })
  set(0, 'Search', { fg = palette.textInverse, bg = palette.ctxAmber })
  set(0, 'IncSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'CurSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'MatchParen', { fg = palette.ctxAmber, bold = true })
  set(0, 'ErrorMsg', { fg = palette.ctxRed })
  set(0, 'WarningMsg', { fg = palette.ctxAmber })
  set(0, 'MsgArea', { fg = palette.textMuted, bg = palette.bg })
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
  -- Full-line diff fills: tint the base bg toward green/red so changed lines
  -- read at a glance without washing out the syntax-colored text on top.
  set(0, 'DiffAdd', { bg = blend(palette.bg, palette.ctxGreen, 0.22) })
  set(0, 'DiffDelete', { bg = blend(palette.bg, palette.ctxRed, 0.22) })
  set(0, 'DiffChange', { bg = blend(palette.bg, palette.ctxAmber, 0.22) })
end

-- Sanctioned user-extension hook (Phase C): a writable init in nvim's data
-- dir (grove userData) is sourced last when present.
pcall(dofile, vim.fs.joinpath(vim.fn.stdpath('data'), 'user', 'init.lua'))
