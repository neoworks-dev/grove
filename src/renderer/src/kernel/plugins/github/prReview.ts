// Reviewing a pull request from inside the editor: the keys that judge the file
// under the cursor, and the notification they raise back into Grove.
//
// The keys are buffer-local to the two halves of the diff rather than global,
// so `a` and `r` keep meaning append and replace everywhere — they hang off
// `<leader>r`, beside the `<leader>tt` the bundled config already uses.
//
// Neovim knows the line and which side of the diff the cursor is on, and
// nothing else; what a verdict means is decided here, where the pull request is.

import { sessionByNvimId, waitForNvimSession } from '../../../lib/nvim/registry'
import { threadVirtualLines } from './prCommentLines'
import type {
  GithubDiffSide,
  GithubItemDetail,
  GithubReviewThread
} from '../../../../../shared/types'

/** What a review key reports back: where the cursor was, and what was asked. */
interface ReviewKeyEvent {
  action?: string
  path?: string
  line?: number
  screenRow?: number
  screenCol?: number
  side?: string
}

export type PrReviewAction = 'accept' | 'reject' | 'comment'

/** Told which file was judged, on which line and side, in which editor pane. */
export interface PrReviewRequest {
  action: PrReviewAction
  detail: GithubItemDetail
  path: string
  line: number
  /** Where that line sits on Neovim's screen, 1-based, for placing the box. */
  screenRow: number
  screenCol: number
  side: GithubDiffSide
  leafId: string
}

// Buffer-local review keys for both halves of the open diff. The side is read
// at press time from the buffer's own mark rather than captured here: one call
// maps both buffers, and only the buffer the key was pressed in knows which it
// was.
const REVIEW_KEYS_LUA = `
local args = ...

local function report(action)
  return function()
    local win = vim.api.nvim_get_current_win()
    local line = vim.api.nvim_win_get_cursor(win)[1]
    -- Where that line actually is on screen. A diff is mostly filler lines, and
    -- folds and wrapping move a line too, so counting buffer lines down from
    -- the top of the window puts the box rows away from the cursor.
    local pos = vim.fn.screenpos(win, line, 1)
    vim.rpcnotify(0, 'grove_pr_review', {
      action = action,
      path = args.path,
      line = line,
      screenRow = pos.row,
      screenCol = pos.col,
      side = vim.b.grove_pr_base and 'LEFT' or 'RIGHT',
    })
  end
end

local keys = {
  { lhs = '<leader>ra', action = 'accept', desc = 'Accept this file and open the next' },
  { lhs = '<leader>rr', action = 'reject', desc = 'Ask for changes to this file' },
  { lhs = '<leader>rc', action = 'comment', desc = 'Comment on this line' },
}

for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local buf = vim.api.nvim_win_get_buf(win)
  for _, key in ipairs(keys) do
    vim.keymap.set('n', key.lhs, report(key.action), {
      buffer = buf,
      desc = key.desc,
      nowait = true,
    })
  end
end

-- Grove owns the leader layer: it reads nvim's mappings and dispatches them
-- itself, rather than letting <Space> through to the buffer. It reads them when
-- a file is opened, which is before this runs, so without telling it these keys
-- exist they are typed past the layer and land in the buffer as motions.
vim.rpcnotify(0, 'grove_keymap_changed', {})
`

// Draw the review's comments into the diff, under the lines they are about and
// on the side they were left on. Cleared and redrawn whole each time: a comment
// can be added, answered or submitted, and working out which extmark that was
// costs more than putting them all back.
const PAINT_COMMENTS_LUA = `
local args = ...
local ns = vim.api.nvim_create_namespace('grove_pr_comments')

local function buffer_for(base)
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    if (vim.b[buf].grove_pr_base == true) == base then return buf end
  end
  return nil
end

for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  vim.api.nvim_buf_clear_namespace(vim.api.nvim_win_get_buf(win), ns, 0, -1)
end

for _, thread in ipairs(args.threads or {}) do
  local buf = buffer_for(thread.base)
  if buf then
    local total = vim.api.nvim_buf_line_count(buf)
    local line = math.max(0, math.min(thread.line - 1, total - 1))
    local virt = {}
    for _, entry in ipairs(thread.lines) do
      virt[#virt + 1] = { { entry.text, entry.hl } }
    end
    if #virt > 0 then
      pcall(vim.api.nvim_buf_set_extmark, buf, ns, line, 0, { virt_lines = virt })
    end
  end
end
`

/**
 * Put the open file's comments into the diff. Threads for other files are
 * ignored — only one file is open — and a thread about the whole file is drawn
 * at the top of it, which is the only place it can go.
 */
export async function paintPrComments(threads: GithubReviewThread[]): Promise<void> {
  if (!openedPath) return
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  const drawn = threads
    .filter((thread) => thread.path === openedPath)
    .map((thread) => ({
      base: thread.side === 'LEFT',
      line: thread.line === null ? 1 : thread.line,
      lines: threadVirtualLines(thread)
    }))
    .filter((thread) => thread.lines.length > 0)
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    PAINT_COMMENTS_LUA,
    [{ threads: drawn }]
  ])
}

// Put the cursor on a line of the open diff, in the half of it the comment was
// left on. The two halves are two windows over two buffers; which is which is
// the mark the base copy carries.
const REVEAL_LUA = `
local args = ...

for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local buf = vim.api.nvim_win_get_buf(win)
  local is_base = vim.b[buf].grove_pr_base == true
  if is_base == args.base then
    local count = vim.api.nvim_buf_line_count(buf)
    local line = math.max(1, math.min(args.line, count))
    vim.api.nvim_win_set_cursor(win, { line, 0 })
    vim.api.nvim_set_current_win(win)
    vim.api.nvim_win_call(win, function() vim.cmd('normal! zz') end)
    return true
  end
end
return false
`

/** Reveal a commented line in the open diff, on the side it was left on. */
export async function revealPrLine(side: GithubDiffSide, line: number): Promise<void> {
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    REVEAL_LUA,
    [{ base: side === 'LEFT', line }]
  ])
}

// The pull request whose file is open, so a keypress from Neovim — which knows
// only a path — can be answered. Replaced on every open; null before the first.
let openedFor: GithubItemDetail | null = null

// The file open in the diff, so the comments drawn into it are that file's.
let openedPath: string | null = null

let listening = false
let handler: ((request: PrReviewRequest) => void) | null = null

/**
 * Route the review keys to a handler. Called once when the GitHub plugin mounts;
 * the subscription itself is made once and kept, the way the scratch buffers do.
 */
export function onPrReviewKey(next: (request: PrReviewRequest) => void): void {
  handler = next
  if (listening) return
  listening = true
  window.workbench.on('event:nvim-notify', (payload) => {
    const event = payload as { id: string; method: string; args: unknown[] }
    if (event.method !== 'grove_pr_review') return
    const request = toRequest(event.id, (event.args?.[0] ?? {}) as ReviewKeyEvent)
    if (request && handler) handler(request)
  })
}

/** One keypress, once the pane and the pull request behind it are resolved. */
function toRequest(nvimId: string, data: ReviewKeyEvent): PrReviewRequest | null {
  if (!openedFor || !data.path || typeof data.line !== 'number') return null
  if (data.action !== 'accept' && data.action !== 'reject' && data.action !== 'comment') return null
  const session = sessionByNvimId(nvimId)
  if (!session) return null
  return {
    action: data.action,
    detail: openedFor,
    path: data.path,
    line: data.line,
    // screenpos answers 0 for a line that is not on screen, which the cursor's
    // never is; treat it as the top rather than trusting it.
    screenRow: data.screenRow && data.screenRow > 0 ? data.screenRow : 1,
    screenCol: data.screenCol && data.screenCol > 0 ? data.screenCol : 1,
    side: data.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    leafId: session.leafId
  }
}

/**
 * Put the review keys on the file that was just opened for a pull request. Run
 * after the diff, so both of its windows are there to map.
 */
export async function installPrReviewKeys(detail: GithubItemDetail, path: string): Promise<void> {
  openedFor = detail
  openedPath = path
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [REVIEW_KEYS_LUA, [{ path }]])
}
