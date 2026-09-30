-- What first-run setup installs: the plugin spec, the mason packages and the
-- treesitter parsers. Grove keys its setup stamp on this file alone (see
-- src/main/nvimSetup.ts), so an edit here reinstalls everything on the next
-- launch and an edit to init.lua does not. Keep anything that installs nothing
-- in init.lua.

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

-- Every mason package, installed by mason-tool-installer. vtsls is the
-- TypeScript server; tree-sitter-cli builds nvim-treesitter's parsers.
local masonPackages = { 'vtsls', 'prettierd', 'eslint_d', 'stylua', 'tree-sitter-cli' }

-- The parsers every editor highlights with, installed by first-run setup.
-- No 'jsonc': the main branch has no separate jsonc grammar (the json parser
-- serves the jsonc filetype), so listing it warns "skipping unsupported
-- language: jsonc".
local treesitterParsers = {
  'typescript', 'tsx', 'javascript', 'json',
  'html', 'css', 'lua', 'vim', 'vimdoc', 'markdown', 'markdown_inline'
}

return {
  masonPackages = masonPackages,
  treesitterParsers = treesitterParsers,
  -- lazy.nvim's plugin spec.
  plugins = {
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
        local parsers = treesitterParsers
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

    -- Install every mason package: the language servers mason-lspconfig
    -- enables and the binaries conform and nvim-lint shell out to.
    {
      'WhoIsSethDaniel/mason-tool-installer.nvim',
      dependencies = { 'williamboman/mason.nvim' },
      opts = {
        ensure_installed = masonPackages,
        -- First-run setup installs these itself, synchronously; a second,
        -- start-up run beside it would race it for the same packages.
        run_on_start = vim.env.GROVE_PROVISION ~= '1'
      }
    },
    {
      'williamboman/mason-lspconfig.nvim',
      dependencies = { 'williamboman/mason.nvim', 'neovim/nvim-lspconfig', 'saghen/blink.cmp' },
      opts = {
        -- The tool installer above installs vtsls with everything else, so
        -- first-run setup has one installer to wait for.
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
  }
}
