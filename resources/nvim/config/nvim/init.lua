-- Grove-managed Neovim config for the embedded editor pane. Lives at
-- ~/.config/grove/nvim (XDG_CONFIG_HOME=~/.config/grove) — for now a symlink
-- to the bundled resources/nvim/config/nvim, so the user's own ~/.config/nvim
-- is never touched. Grove owns tabs and the statusline, so nvim's chrome is
-- disabled; the in-grid cmdline row stays (search/:s preview, wildmenu,
-- hit-enter prompts).

vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.signcolumn = 'yes'
vim.opt.laststatus = 0
vim.opt.showtabline = 0
vim.opt.cmdheight = 1
vim.opt.undofile = true
vim.opt.swapfile = true
vim.opt.mouse = 'a'
vim.opt.shortmess:append('I')
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

      -- Treesitter syntax + indentation. Parsers compile into the writable
      -- lazy dir on first use; auto_install pulls any missing language.
      {
        'nvim-treesitter/nvim-treesitter',
        branch = 'master',
        build = ':TSUpdate',
        opts = {
          ensure_installed = {
            'typescript', 'tsx', 'javascript', 'json', 'jsonc',
            'html', 'css', 'lua', 'vim', 'vimdoc', 'markdown'
          },
          auto_install = true,
          highlight = { enable = true },
          indent = { enable = true }
        },
        config = function(_, opts)
          require('nvim-treesitter.configs').setup(opts)
        end
      },

      -- LSP: mason installs the servers into the writable data dir,
      -- mason-lspconfig enables them through nvim's built-in LSP registry.
      { 'williamboman/mason.nvim', opts = {} },
      {
        'williamboman/mason-lspconfig.nvim',
        dependencies = { 'williamboman/mason.nvim', 'neovim/nvim-lspconfig' },
        opts = {
          ensure_installed = { 'ts_ls' },
          automatic_installation = true
        },
        config = function(_, opts)
          require('mason').setup()
          require('mason-lspconfig').setup(opts)
          -- Belt-and-suspenders on nvim 0.11+: enable the server explicitly in
          -- case mason-lspconfig's automatic enable is unavailable.
          pcall(vim.lsp.enable, 'ts_ls')
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
