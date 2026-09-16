// The editing flow: open a file, change it, save it.
//
// Everything else in this suite asserts on what grove *shows*. This file
// asserts on what it *does* — the keystrokes go to the real embedded Neovim,
// and the check is the file on disk afterwards, which no amount of correct
// rendering can fake.
//
// The editor is a canvas, so the buffer's text is not in the DOM. That is fine:
// the three things worth knowing are readable anyway — the mode indicator in
// the status bar says nvim received the keys, the dot on the tab says it
// considers the buffer modified, and the file on disk says the write landed.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, type Page } from './fixtures/groveApp'

/** A row of the explorer tree, addressed by the name it shows. */
function treeRow(page: Page, name: string) {
  return page.locator('[role="treeitem"]', { hasText: name }).first()
}

/** A buffer tab, addressed by the file it holds. */
function tab(page: Page, relativePath: string) {
  return page.locator(`[data-tab$="${relativePath}"]`)
}

/** The unsaved-changes dot the tab strip puts ahead of a modified file. */
function unsavedMarker(page: Page) {
  return page.locator('[title="Unsaved changes"]')
}

/**
 * Open a file from the explorer, and wait for the editor to hold it.
 *
 * Files under `src/` need the directory expanded first; the tree loads its
 * children on demand, so the child row does not exist until then. A row that is
 * already expanded is left alone — clicking it again folds it shut, which is
 * what the second call in a test would otherwise do.
 */
async function openFromExplorer(page: Page, relativePath: string): Promise<void> {
  const segments = relativePath.split('/')
  const fileName = segments.pop() as string

  for (const directory of segments) {
    if (await treeRow(page, fileName).isVisible()) break
    await treeRow(page, directory).click()
    await expect(treeRow(page, fileName)).toBeVisible()
  }

  await treeRow(page, fileName).click()
  await expect(tab(page, relativePath)).toBeVisible()
  // The tab appears as soon as the renderer knows about the file; the
  // breadcrumb is fed by nvim's own current buffer, so it is the signal that
  // keystrokes will land in the file rather than in whatever preceded it.
  await expect(page.getByRole('contentinfo')).toContainText(fileName)
}

/**
 * Insert a line at the top of the buffer and write it.
 *
 * `O` opens above line 1 rather than below the last one, which keeps the text
 * out of reach of nvim's comment continuation — the demo files end in a
 * comment, and a line opened under one arrives already prefixed with `//`.
 */
async function insertLineAndSave(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('g')
  await page.keyboard.press('Shift+O')
  // Wait for nvim to report the mode change before typing. Under load the
  // editor can still be attaching when the first keys arrive, and text typed
  // in normal mode is a string of motions rather than a line.
  await expect(page.getByRole('contentinfo')).toContainText('INSERT')

  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('contentinfo')).toContainText('NORMAL')

  await page.keyboard.type(':w')
  await page.keyboard.press('Enter')
}

/** The file as it is on disk in the demo repo's main worktree. */
function readFromRepo(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8')
}

test('opening a file from the explorer puts it in the editor', async ({ grove }) => {
  await expect(grove.page.getByText('No file open')).toBeVisible()

  await openFromExplorer(grove.page, 'src/index.ts')

  // The empty state gives way to the buffer, and the breadcrumb in the status
  // bar names the path the editor actually loaded.
  await expect(grove.page.getByText('No file open')).toHaveCount(0)
  await expect(grove.page.getByRole('contentinfo')).toContainText('index.ts')
})

test('typing reaches neovim and marks the buffer unsaved', async ({ grove }) => {
  await openFromExplorer(grove.page, 'src/index.ts')
  await expect(unsavedMarker(grove.page)).toHaveCount(0)

  await grove.page.keyboard.press('Escape')
  await grove.page.keyboard.press('g')
  await grove.page.keyboard.press('g')
  await grove.page.keyboard.press('Shift+O')
  await grove.page.keyboard.type('const typed = true')

  // nvim's own mode, read off the status bar: proof the keys were routed to the
  // editor rather than swallowed by the window.
  await expect(grove.page.getByRole('contentinfo')).toContainText('INSERT')
  await expect(unsavedMarker(grove.page)).toHaveCount(1)
})

test('saving writes the edit to disk and clears the unsaved marker', async ({ grove }) => {
  await openFromExplorer(grove.page, 'src/index.ts')
  await insertLineAndSave(grove.page, 'const saved = 1')

  await expect(unsavedMarker(grove.page)).toHaveCount(0)

  // The assertion that cannot be satisfied by the UI alone.
  await expect
    .poll(() => readFromRepo(grove.demo.root, 'src/index.ts'))
    .toContain('const saved = 1')
})

test('a saved edit shows up in git changes', async ({ grove }) => {
  // src/clean.ts is committed and untouched by the fixture, so it appears in
  // the view only if the editor really changed it.
  await openFromExplorer(grove.page, 'src/clean.ts')
  await insertLineAndSave(grove.page, 'const written = true')
  await expect(unsavedMarker(grove.page)).toHaveCount(0)

  await grove.page.getByTitle('Git Changes', { exact: true }).click()

  await expect(grove.page.getByRole('button', { name: 'M src/clean.ts' })).toBeVisible()
})

test('two files open as two tabs, and closing one leaves the other', async ({ grove }) => {
  await openFromExplorer(grove.page, 'src/index.ts')
  await openFromExplorer(grove.page, 'src/util.ts')

  await expect(grove.page.locator('[data-tab]')).toHaveCount(2)

  // The close button is zero-width until the tab is hovered and its transition
  // has run, so it needs waiting for rather than clicking at.
  const closeUtil = tab(grove.page, 'src/util.ts').getByTitle('Close tab')
  await tab(grove.page, 'src/util.ts').hover()
  await expect(closeUtil).toBeVisible()
  await closeUtil.click()

  await expect(grove.page.locator('[data-tab]')).toHaveCount(1)
  await expect(tab(grove.page, 'src/index.ts')).toBeVisible()
})

test('the file finder opens a file by name', async ({ grove }) => {
  await openFromExplorer(grove.page, 'src/index.ts')

  // Leader-leader is the binding the File menu advertises for "Go to File…".
  await grove.page.keyboard.press('Escape')
  await grove.page.keyboard.press('Space')
  await grove.page.keyboard.press('Space')

  const finder = grove.page.getByRole('dialog')
  await expect(finder.getByRole('textbox', { name: 'Search files by name…' })).toBeVisible()

  await grove.page.keyboard.type('util')
  // Filtering is the point of the finder: everything else drops away.
  await expect(finder.getByRole('button')).toHaveCount(1)

  await grove.page.keyboard.press('Enter')
  await expect(tab(grove.page, 'src/util.ts')).toBeVisible()
})
