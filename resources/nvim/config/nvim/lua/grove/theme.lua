-- Mix two "#rrggbb" colors; ratio 0 = base, 1 = tint. Used to derive subtle
-- diff line backgrounds from the saturated context colors.
local function blend(base, tint, ratio)
  local function channels(hex)
    local h = hex:gsub("#", "")
    return tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16)
  end
  local br, bg, bb = channels(base)
  local tr, tg, tb = channels(tint)
  local function mix(a, b)
    return math.floor(a + (b - a) * ratio + 0.5)
  end
  return string.format("#%02x%02x%02x", mix(br, tr), mix(bg, tg), mix(bb, tb))
end

-- Load Catppuccin as the code theme: Mocha on a dark app theme, Latte on a
-- light one. Its background shades are swapped for grove's, so the buffer sits
-- on the same surface as the panes around it whatever the app theme is.
-- Returns false when the plugin is not installed (first launch offline), and
-- the caller falls back to syntax colours derived from the app palette.
local function apply_code_theme(palette, scheme)
  local function hex(value)
    if type(value) == "string" and value:match("^#%x%x%x%x%x%x$") then
      return value
    end
    return nil
  end
  local ok, catppuccin = pcall(require, "catppuccin")
  if not ok then
    return false
  end
  local flavour = "mocha"
  if scheme == "light" then
    flavour = "latte"
  end
  catppuccin.setup({
    flavour = flavour,
    color_overrides = {
      [flavour] = { base = hex(palette.surface), mantle = hex(palette.bgElevated), crust = hex(palette.bg) },
    },
    integrations = {
      blink_cmp = true,
      flash = true,
      gitsigns = true,
      illuminate = { enabled = true },
      mason = true,
      noice = true,
      snacks = { enabled = true, indent_scope_color = "overlay2" },
      treesitter = true,
    },
  })
  return pcall(vim.cmd.colorscheme, "catppuccin-" .. flavour)
end

-- Syntax colours from the app palette's context colours, for when the code
-- theme could not be loaded.
local function apply_palette_syntax(palette)
  local set = vim.api.nvim_set_hl
  set(0, "Visual", { bg = palette.borderStrong })
  set(0, "LineNr", { fg = palette.textDim })
  set(0, "CursorLine", { bg = palette.surfaceHover })
  set(0, "CursorLineNr", { fg = palette.textMuted })
  set(0, "Search", { fg = palette.textInverse, bg = palette.ctxAmber })
  set(0, "IncSearch", { fg = palette.textInverse, bg = palette.primary })
  set(0, "CurSearch", { fg = palette.textInverse, bg = palette.primary })
  set(0, "MatchParen", { fg = palette.ctxAmber, bold = true })
  set(0, "ErrorMsg", { fg = palette.ctxRed })
  set(0, "WarningMsg", { fg = palette.ctxAmber })
  set(0, "Question", { fg = palette.ctxGreen })
  set(0, "Directory", { fg = palette.ctxBlue })
  set(0, "Title", { fg = palette.ctxViolet, bold = true })
  set(0, "NonText", { fg = palette.textFaint })
  set(0, "Whitespace", { fg = palette.textFaint })
  -- Base syntax groups from the shared context colors.
  set(0, "Comment", { fg = palette.textDim, italic = true })
  set(0, "String", { fg = palette.ctxGreen })
  set(0, "Number", { fg = palette.ctxAmber })
  set(0, "Boolean", { fg = palette.ctxAmber })
  set(0, "Constant", { fg = palette.ctxAmber })
  set(0, "Identifier", { fg = palette.text })
  set(0, "Function", { fg = palette.ctxBlue })
  set(0, "Statement", { fg = palette.ctxViolet })
  set(0, "Keyword", { fg = palette.ctxViolet })
  set(0, "Operator", { fg = palette.textMuted })
  set(0, "Type", { fg = palette.ctxBlue })
  set(0, "PreProc", { fg = palette.ctxPink })
  set(0, "Special", { fg = palette.ctxPink })
  set(0, "Delimiter", { fg = palette.textMuted })
end

-- Same-token highlights are an underline and nothing else: no fill over the
-- code theme's, and no colour of their own, so the underline is drawn in the
-- colour of the token it sits under.
local function underline_same_token()
  for _, group in ipairs({ "IlluminatedWordText", "IlluminatedWordRead", "IlluminatedWordWrite" }) do
    vim.api.nvim_set_hl(0, group, { underline = true })
  end
end

-- The groups that belong to grove's chrome rather than to the code: the
-- surfaces, floats and menus, the cursor, the diff fills the review flow paints
-- with, and the terminal colours. Applied last, over the code theme.
-- The editor sits in a pane next to grove's own panes, so it paints on the
-- surface pane background rather than the canvas underneath them. Floats use
-- that surface too, so a popup terminal matches grove's terminal pane; their
-- border and grove's frame set them apart. Menus step up to the elevated level.
local function apply_chrome(palette)
  local set = vim.api.nvim_set_hl
  set(0, "Normal", { fg = palette.text, bg = palette.surface })
  set(0, "NormalNC", { fg = palette.text, bg = palette.surface })
  set(0, "NormalFloat", { fg = palette.text, bg = palette.surface })
  set(0, "FloatBorder", { fg = palette.border, bg = palette.surface })
  -- One fixed pair, not the colours of the cell underneath: the cursor has to
  -- be findable on a comment as easily as on a keyword.
  set(0, "Cursor", { fg = palette.primaryFg, bg = palette.primary })
  set(0, "lCursor", { fg = palette.primaryFg, bg = palette.primary })
  set(0, "TermCursor", { fg = palette.primaryFg, bg = palette.primary })
  set(0, "SignColumn", { bg = palette.surface })
  set(0, "EndOfBuffer", { fg = palette.surface })
  set(0, "WinSeparator", { fg = palette.border })
  set(0, "Pmenu", { fg = palette.text, bg = palette.bgElevated })
  set(0, "PmenuSel", { fg = palette.textInverse, bg = palette.primary })
  set(0, "PmenuSbar", { bg = palette.bgElevated })
  set(0, "PmenuThumb", { bg = palette.borderStrong })
  set(0, "MsgArea", { fg = palette.textMuted, bg = palette.surface })
  -- Full-line diff fills: tint the base bg toward green/red so changed lines
  -- read at a glance without washing out the syntax-colored text on top.
  set(0, "DiffAdd", { bg = blend(palette.surface, palette.ctxGreen, 0.22) })
  set(0, "DiffDelete", { bg = blend(palette.surface, palette.ctxRed, 0.22) })
  set(0, "DiffChange", { bg = blend(palette.surface, palette.ctxAmber, 0.22) })
  -- The debugger's gutter signs and the line execution stopped on (debug.lua).
  set(0, "GroveBreakpoint", { fg = palette.ctxRed })
  set(0, "GroveLogpoint", { fg = palette.ctxBlue })
  set(0, "GroveBreakpointUnverified", { fg = palette.textDim })
  set(0, "GroveBreakpointDisabled", { fg = palette.textDim })
  set(0, "GroveDebugStopped", { fg = palette.ctxAmber })
  set(0, "GroveDebugStoppedLine", { bg = blend(palette.surface, palette.ctxAmber, 0.18) })

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

-- Grove can send its theme while the config is still loading: nvim answers RPC
-- while lazy installs missing plugins (grove.plugins), before grove_apply_theme exists.
-- Grove leaves the theme in vim.g.grove_theme for exactly that case, and it is
-- applied here, once the plugins (and so the code theme) are in place.
if type(vim.g.grove_theme) == "table" then
  _G.grove_apply_theme(vim.g.grove_theme.palette, vim.g.grove_theme.scheme)
end
