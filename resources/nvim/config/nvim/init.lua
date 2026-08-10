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
-- Route yanks and puts through the desktop clipboard. Without this the '+'
-- register is never touched, so nothing yanked in an editor pane can be pasted
-- outside grove. nvim picks its own provider (wl-copy, xclip, pbcopy, win32yank);
-- grove spawns nvim with the full parent environment, so WAYLAND_DISPLAY and
-- DISPLAY are present for the detection to succeed.
vim.opt.clipboard = 'unnamedplus'
-- Keep 4 context lines visible above/below the cursor when scrolling.
vim.opt.scrolloff = 4
-- Also suppress the swap/attention message class outright as a belt-and-suspenders.
vim.opt.shortmess:append('IA')
vim.opt.fillchars = { eob = ' ' }

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
if not (vim.uv or vim.loop).fs_stat(lazyPath) then
  vim.fn.system({
    'git', 'clone', '--filter=blob:none', '--branch=stable',
    'https://github.com/folke/lazy.nvim.git', lazyPath
  })
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
          completion = { documentation = { auto_show = true } }
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

-- Inlay hints are off until something turns them on, so a server advertising
-- the capability still renders nothing. Turn them on per buffer as each capable
-- server attaches.
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if not client or not client:supports_method('textDocument/inlayHint') then
      return
    end
    pcall(vim.lsp.inlay_hint.enable, true, { bufnr = args.buf })
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

-- The editor sits in a pane next to grove's own panes, so it paints on the
-- surface pane background rather than the canvas underneath them; floats and
-- menus step up to the elevated level so they still read as raised.
_G.grove_apply_theme = function(palette)
  local set = vim.api.nvim_set_hl
  set(0, 'Normal', { fg = palette.text, bg = palette.surface })
  set(0, 'NormalNC', { fg = palette.text, bg = palette.surface })
  set(0, 'NormalFloat', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'FloatBorder', { fg = palette.border, bg = palette.bgElevated })
  set(0, 'Visual', { bg = palette.borderStrong })
  set(0, 'LineNr', { fg = palette.textDim })
  set(0, 'CursorLine', { bg = palette.surfaceHover })
  set(0, 'CursorLineNr', { fg = palette.textMuted })
  set(0, 'SignColumn', { bg = palette.surface })
  set(0, 'EndOfBuffer', { fg = palette.surface })
  set(0, 'WinSeparator', { fg = palette.border })
  set(0, 'Pmenu', { fg = palette.text, bg = palette.bgElevated })
  set(0, 'PmenuSel', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'PmenuSbar', { bg = palette.bgElevated })
  set(0, 'PmenuThumb', { bg = palette.borderStrong })
  set(0, 'Search', { fg = palette.textInverse, bg = palette.ctxAmber })
  set(0, 'IncSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'CurSearch', { fg = palette.textInverse, bg = palette.primary })
  set(0, 'MatchParen', { fg = palette.ctxAmber, bold = true })
  set(0, 'ErrorMsg', { fg = palette.ctxRed })
  set(0, 'WarningMsg', { fg = palette.ctxAmber })
  set(0, 'MsgArea', { fg = palette.textMuted, bg = palette.surface })
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
  set(0, 'DiffAdd', { bg = blend(palette.surface, palette.ctxGreen, 0.22) })
  set(0, 'DiffDelete', { bg = blend(palette.surface, palette.ctxRed, 0.22) })
  set(0, 'DiffChange', { bg = blend(palette.surface, palette.ctxAmber, 0.22) })
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

-- Sanctioned user-extension hook (Phase C): a writable init in nvim's data
-- dir (grove userData) is sourced last when present.
pcall(dofile, vim.fs.joinpath(vim.fn.stdpath('data'), 'user', 'init.lua'))
