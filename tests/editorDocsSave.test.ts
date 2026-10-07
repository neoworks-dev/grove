// A save through the document bridge, as an agent's write or a plugin makes it.
//
// The caller holds the version it wrote, so the save has to put exactly that
// text on disk: a BufWritePre hook (format-on-save, editorconfig trimming)
// rewriting the buffer would leave the caller working from stale text. Hooks
// after the write still have to run, since linters, the language server and
// Grove's own write tracking listen there.
// Runs the bundled nvim headless, with its own XDG dirs so the user's are
// never touched.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NvimRpc } from '../src/main/nvimRpc'
import { DocumentRegistry } from '../src/main/editorDocs'

const NVIM = join(
  import.meta.dir,
  '..',
  'resources',
  'nvim',
  'dist',
  `${process.platform}-${process.arch}`,
  'bin',
  'nvim'
)

const WORKTREE_ID = 'worktree'
const SESSION_ID = 'session'

// Stands in for conform's format-on-save, and for whatever listens after a write.
const HOOKS_LUA = `
vim.api.nvim_create_autocmd('BufWritePre', {
  callback = function(args)
    vim.api.nvim_buf_set_lines(args.buf, 0, -1, false, { 'formatted' })
  end,
})
vim.api.nvim_create_autocmd('BufWritePost', {
  callback = function() vim.g.post_ran = true end,
})
`

let home: string
let child: ChildProcess
let nvim: NvimRpc
let documents: DocumentRegistry

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'grove-save-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    env[`XDG_${name}_HOME`] = join(home, name.toLowerCase())
  }
  child = spawn(NVIM, ['--embed', '--headless', '--clean', '-n'], { env })
  nvim = new NvimRpc(child.stdin!, child.stdout!)
  documents = new DocumentRegistry({
    nvim: { request: (_sessionId, method, args) => nvim.request(method, args) },
    sessionFor: () => SESSION_ID,
    allSessions: () => [{ sessionId: SESSION_ID, worktreeId: WORKTREE_ID }],
    activeSession: () => ({ sessionId: SESSION_ID, worktreeId: WORKTREE_ID }),
    worktreePathOf: () => home,
    publish: () => {}
  })
  await writeFile(join(home, 'file.lua'), 'local before = 1\n')
  await nvim.request('nvim_exec_lua', [HOOKS_LUA, []])
})

afterEach(async () => {
  nvim.close()
  child.kill()
  await rm(home, { recursive: true, force: true })
})

/** Writes `lines` into the open file and saves it through the bridge. */
async function writeAndSave(lines: string[]): Promise<void> {
  const opened = await documents.open(WORKTREE_ID, 'file.lua')
  const replaced = await documents.replaceLines(WORKTREE_ID, 'file.lua', opened.version, lines)
  if (replaced.status !== 'applied') throw new Error('replace went stale')
  const saved = await documents.save(WORKTREE_ID, 'file.lua', replaced.version)
  if (saved.status !== 'applied') throw new Error('save went stale')
}

test('a save puts exactly the written text on disk, unformatted', async () => {
  await writeAndSave(['local after = 2'])
  expect(await readFile(join(home, 'file.lua'), 'utf8')).toBe('local after = 2\n')
  const buffer = await nvim.request('nvim_exec_lua', [
    'return vim.fn.bufnr(...)',
    [join(home, 'file.lua')]
  ])
  expect(await nvim.request('nvim_buf_get_lines', [buffer, 0, -1, false])).toEqual([
    'local after = 2'
  ])
})

test('hooks after the write still run', async () => {
  await writeAndSave(['local after = 2'])
  expect(await nvim.request('nvim_get_var', ['post_ran'])).toBe(true)
})

test('eventignore is left as it was', async () => {
  await nvim.request('nvim_set_option_value', ['eventignore', 'FocusGained', {}])
  await writeAndSave(['local after = 2'])
  expect(await nvim.request('nvim_get_option_value', ['eventignore', {}])).toBe('FocusGained')
})
