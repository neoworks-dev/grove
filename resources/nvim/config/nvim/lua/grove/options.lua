-- Space is the shared leader: grove owns the space-leader which-key overlay and
-- forwards completed leader sequences back here, so nvim's own <leader> maps
-- appear in that overlay and stay executable. Set before any plugin maps load.
vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.signcolumn = "yes"
vim.opt.laststatus = 0
vim.opt.showtabline = 0
vim.opt.cmdheight = 1
vim.opt.undofile = true
-- Write-backups default to the file's own directory ('.') first, so a session
-- killed mid-:w (e.g. a dev reload) leaves a stray `file~` in the worktree.
-- Keep them in the isolated state dir instead.
vim.opt.backupdir:remove(".")
-- No swapfiles: every grove pane is its own embedded nvim, so two panes editing
-- the same file would collide on a swapfile and trigger a blocking E325 ATTENTION
-- prompt on attach (which aborts the session). Grove owns buffer persistence.
vim.opt.swapfile = false
vim.opt.mouse = "a"
-- One line per wheel step: grove measures the wheel's travel and sends one
-- step per line of it (lib/nvim/wheel.ts), so a touchpad scrolls as far as
-- the fingers moved rather than three lines per event.
vim.opt.mousescroll = "ver:1,hor:1"
-- Route yanks and puts through the desktop clipboard. Without this the '+'
-- register is never touched, so nothing yanked in an editor pane can be pasted
-- outside grove. nvim picks its own provider (wl-copy, xclip, pbcopy, win32yank);
-- grove spawns nvim with the full parent environment, so WAYLAND_DISPLAY and
-- DISPLAY are present for the detection to succeed.
vim.opt.clipboard = "unnamedplus"
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
vim.opt.shortmess:append("IA")
vim.opt.fillchars = { eob = " " }
-- nvim's stock 'guicursor' names no highlight group, which leaves a GUI with
-- nothing to paint the cursor in but reverse video — so it takes the colour of
-- whatever token it happens to sit on and disappears into a comment or a
-- string. Naming Cursor/lCursor makes every mode report a highlight, and the
-- theme decides what that is.
vim.opt.guicursor = table.concat({
  "n-v-c-sm:block-Cursor/lCursor",
  "i-ci-ve:ver25-Cursor/lCursor",
  "r-cr-o:hor20-Cursor/lCursor",
  "t:block-blinkon500-blinkoff500-TermCursor",
}, ",")

-- Second line of defence: even with 'swapfile' off above, a plugin or the user
-- extension hook at the bottom of init.lua can turn it back on, and a leftover
-- swapfile from an older session would then raise the blocking E325 prompt
-- ("[O]pen Read-Only, (E)dit anyway, …"). That prompt has no answerer in grove:
-- it stalls the msgpack request that opened the file. Answer it as "edit anyway"
-- — grove owns buffer persistence, so a stale swapfile carries nothing to keep.
vim.api.nvim_create_autocmd("SwapExists", {
  callback = function()
    vim.v.swapchoice = "e"
  end,
})
