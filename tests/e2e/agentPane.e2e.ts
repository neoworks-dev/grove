// The agent pane, driven the way a user drives it.
//
// The companion spec (`permissionModes.e2e.ts`) asserts on the IPC surface,
// which is where the architectural bug lived. This one clicks, because the two
// halves failed independently: the picker reported the mode it had been given
// while the session it named was still in the asking one. Only a test that
// changes the mode through the control and then reads the session can see them
// disagree.
//
// The control is addressed by data-testid rather than by its label. Every mode
// name appears twice over — once on the trigger and once in the menu — so a
// by-name locator matches both and resolves to nothing.

import { test, expect, type Page, type GroveWindow } from './fixtures/groveApp'

const trigger = (page: Page) => page.getByTestId('agent-mode-trigger')

/** The menu entry for a mode, matched on the mode itself rather than its label. */
function modeOption(page: Page, mode: string) {
  return page.locator(`[data-testid="agent-mode-option"][data-mode="${mode}"]`)
}

/**
 * Start a session the way the pane offers it, and hand back its id.
 *
 * The pane is already on screen when grove opens, so this is the same two
 * clicks a user makes. The id is read afterwards rather than being handed in,
 * which is what lets the assertions check the session the UI actually made.
 */
async function startSession(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(trigger(page)).toBeVisible()

  return page.evaluate(async () => {
    const view = window as unknown as GroveWindow
    const sessions = await view.workbench.agents.listSessions()
    return sessions[sessions.length - 1].id
  })
}

test('the mode control offers every mode', async ({ grove }) => {
  await startSession(grove.page)
  await trigger(grove.page).click()

  for (const mode of ['default', 'plan', 'acceptEdits', 'bypass']) {
    await expect(modeOption(grove.page, mode)).toBeVisible()
  }
  await expect(modeOption(grove.page, 'acceptEdits')).toContainText('Accept edits')
})

test('picking accept-edits in the UI puts the session into it', async ({ grove }) => {
  const sessionId = await startSession(grove.page)

  await trigger(grove.page).click()
  await modeOption(grove.page, 'acceptEdits').click()

  // The control has to agree...
  await expect(trigger(grove.page)).toContainText('Accept edits')

  // ...and so does the session the main process is gating. This is the pair
  // that used to come apart: the label changed and the session did not.
  const stored = await grove.page.evaluate(async (id) => {
    const view = window as unknown as GroveWindow
    return (await view.workbench.agents.getSession(id)).permissionMode
  }, sessionId)
  expect(stored).toBe('acceptEdits')
})

test('the mode the control shows survives reopening the session', async ({ grove }) => {
  const sessionId = await startSession(grove.page)

  await trigger(grove.page).click()
  await modeOption(grove.page, 'bypass').click()
  await expect(trigger(grove.page)).toContainText('Bypass')

  // Drop the session from the renderer and load it again, which is what
  // switching worktrees and coming back does.
  await grove.page.evaluate((id) => {
    const sessions = (window as unknown as GroveWindow).__grove_debug?.agentSessions
    sessions?.close?.(id)
    return sessions?.open?.(id)
  }, sessionId)

  await expect(trigger(grove.page)).toContainText('Bypass')
})
