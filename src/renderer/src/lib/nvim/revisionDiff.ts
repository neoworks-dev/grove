// A file as one revision left it, beside the same file at another, in Neovim's
// own diff mode. When both sides are history, both are read-only scratch
// buffers: the right one is a Grove tab named `file @ sha`, the left one sits
// in a window inside the same editor pane, the way the pull-request diff places
// its base side. Against the working tree, the right side is the real file
// instead — editable, with its language server.
//
// The left window is marked `grove_revision_base`, which is how the next diff
// reuses it instead of stacking another split, and how it is closed once the
// right side leaves its window.

import { openScratch } from './scratch.svelte'
import { waitForNvimSession } from './registry'
import { store, openFileInEditor } from '../store.svelte'
import type { CommitSummary, DiffFile } from '../../../../shared/types'

export interface RevisionDiffRequest {
  worktreeId: string
  /** The file's path at the right-hand revision. */
  path: string
  /** Its path at the left-hand revision, when it was renamed in between. */
  oldPath?: string
  /** The older revision, or null when the file did not exist before. */
  leftRevision: string | null
  /** The newer revision, or null when the file no longer exists there. */
  rightRevision: string | null
  /** How each side's revision reads in its buffer name, e.g. a short sha. */
  leftLabel: string
  rightLabel: string
}

const DIFF_LUA = `
local args = ...

local function base_windows()
  local found = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.w[win].grove_revision_base then table.insert(found, win) end
  end
  return found
end

local function base_buffer()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].swapfile = false
  vim.bo[buf].bufhidden = 'wipe'
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, args.lines)
  pcall(vim.api.nvim_buf_set_name, buf, args.name)
  -- The name ends in ' @ <rev>', so the filetype is matched from the real path.
  local filetype = vim.filetype.match({ filename = args.path })
  if filetype then vim.bo[buf].filetype = filetype end
  vim.bo[buf].modifiable = false
  return buf
end

pcall(function() vim.opt.diffopt:append('linematch:60') end)

local right = vim.api.nvim_get_current_win()
local right_buf = vim.api.nvim_get_current_buf()
local filetype = vim.filetype.match({ filename = args.path })
if filetype then vim.bo[right_buf].filetype = filetype end

-- Neovim diffs every buffer in the tab page's diff set, not a pair of windows,
-- so whatever the last diff left in it would be diffed against as well.
vim.cmd('silent! diffoff!')

local base = base_buffer()
local existing = base_windows()[1]
if existing then
  vim.api.nvim_win_set_buf(existing, base)
else
  vim.cmd('leftabove vsplit')
  existing = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(existing, base)
  -- Keeps the left side inside the editor pane instead of a Grove pane of its
  -- own: the two halves are one view of one change.
  vim.w[existing].grove_embedded = true
  vim.w[existing].grove_revision_base = true
end

vim.api.nvim_win_call(existing, function() vim.cmd('diffthis') end)
vim.api.nvim_win_call(right, function() vim.cmd('diffthis') end)

-- Once the right side leaves its window (tab switch, :q), the left side has
-- nothing to be a diff against, so it goes too.
vim.api.nvim_create_autocmd('BufWinLeave', {
  buffer = right_buf,
  once = true,
  callback = function()
    vim.schedule(function()
      for _, win in ipairs(base_windows()) do pcall(vim.api.nvim_win_close, win, true) end
      pcall(vim.cmd, 'diffoff!')
    end)
  end,
})

vim.api.nvim_set_current_win(right)
vim.cmd('silent! normal! gg]c')
`

/** The last path segment, which is what a tab shows. */
function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return path
  return path.slice(slash + 1)
}

/** A side's content, or nothing for a revision the file did not exist at. */
async function contentAt(
  worktreeId: string,
  revision: string | null,
  path: string
): Promise<string> {
  if (revision === null) return ''
  return window.workbench.git.fileAtRevision(worktreeId, revision, path)
}

/** A file's lines, without the empty one a final newline would add. */
function linesOf(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Both sides' lines, or null (with the error shown) when either cannot be read. */
async function readSides(
  request: RevisionDiffRequest,
  leftPath: string
): Promise<{ left: string[]; right: string[] } | null> {
  try {
    const [left, right] = await Promise.all([
      contentAt(request.worktreeId, request.leftRevision, leftPath),
      contentAt(request.worktreeId, request.rightRevision, request.path)
    ])
    return { left: linesOf(left), right: linesOf(right) }
  } catch (err) {
    store.setError((err as Error).message)
    return null
  }
}

/** One revision's lines, or null (with the error shown) when it cannot be read. */
async function readRevision(
  worktreeId: string,
  revision: string,
  path: string
): Promise<string[] | null> {
  try {
    return linesOf(await contentAt(worktreeId, revision, path))
  } catch (err) {
    store.setError((err as Error).message)
    return null
  }
}

/** Opens the diff between two revisions of a file in the editor. */
export async function openRevisionDiff(request: RevisionDiffRequest): Promise<void> {
  let leftPath = request.path
  if (request.oldPath) leftPath = request.oldPath
  const sides = await readSides(request, leftPath)
  if (!sides) return

  const opened = await openScratch({
    title: `${baseName(request.path)} @ ${request.rightLabel}`,
    tabName: baseName(request.path),
    diff: { left: request.leftLabel, right: request.rightLabel },
    lines: sides.right,
    readonly: true,
    onWrite: () => {}
  })
  if (!opened) return

  const session = await waitForNvimSession()
  if (!session || !session.id) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    DIFF_LUA,
    [{ name: `${leftPath} @ ${request.leftLabel}`, path: request.path, lines: sides.left }]
  ])
}

/** How long to wait for the editor to finish opening the working-tree file. */
const OPEN_TIMEOUT_MS = 4000

/**
 * Opens a working-tree file beside its copy at a revision. A file the working
 * tree no longer has is shown as history against nothing instead.
 */
export async function openWorkingTreeDiff(request: {
  worktreeId: string
  worktreePath: string
  path: string
  oldPath?: string
  revision: string
  label: string
  deleted: boolean
}): Promise<void> {
  if (request.deleted) {
    await openRevisionDiff({
      worktreeId: request.worktreeId,
      path: request.path,
      oldPath: request.oldPath,
      leftRevision: request.revision,
      rightRevision: null,
      leftLabel: request.label,
      rightLabel: 'working tree'
    })
    return
  }
  let leftPath = request.path
  if (request.oldPath) leftPath = request.oldPath
  const left = await readRevision(request.worktreeId, request.revision, leftPath)
  if (!left) return

  const absolutePath = `${request.worktreePath}/${request.path}`
  openFileInEditor(request.worktreeId, absolutePath)
  store.setTabDiff(request.worktreeId, absolutePath, {
    left: request.label,
    right: 'working tree'
  })
  const session = await waitForNvimSession()
  if (!session || !session.id) return
  if (!(await waitForActiveFile(session, request.path))) return
  await window.workbench.nvim.request(session.id, 'nvim_exec_lua', [
    DIFF_LUA,
    [{ name: `${leftPath} @ ${request.label}`, path: request.path, lines: left }]
  ])
}

/**
 * Waits for the editor to show a file. `openFileInEditor` only writes the tab;
 * the pane pushes it to Neovim from an effect, so diffing at once would diff
 * whatever was open before.
 */
async function waitForActiveFile(
  session: { getActiveFile: () => Promise<{ path: string } | null> },
  relativePath: string
): Promise<boolean> {
  const deadline = performance.now() + OPEN_TIMEOUT_MS
  while (performance.now() < deadline) {
    const active = await session.getActiveFile()
    if (active && active.path.endsWith(`/${relativePath}`)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * Opens one file a commit changed, as the commit left it beside the commit's
 * first parent — or beside nothing, for a root commit.
 */
export function openCommitFileDiff(worktreeId: string, commit: CommitSummary, file: DiffFile): void {
  let parent: string | null = null
  let parentLabel = 'empty'
  if (commit.parents.length > 0) {
    parent = commit.parents[0]
    parentLabel = parent.slice(0, commit.shortSha.length)
  }
  void openRevisionDiff({
    worktreeId,
    path: file.path,
    oldPath: file.oldPath,
    leftRevision: parent,
    rightRevision: commit.sha,
    leftLabel: parentLabel,
    rightLabel: commit.shortSha
  })
}
