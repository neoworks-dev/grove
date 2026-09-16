// The agent pane, driven the way a user drives it.
//
// The companion spec (`permissionModes.e2e.ts`) asserts on the IPC surface,
// which is where the architectural bug lived. This one clicks, because the two
// halves failed independently: the picker reported the mode it had been given
// while the session it named was still in the asking one. Only a test that
// changes the mode through the control and then reads the session can see them
// disagree.

import { test, expect, type GroveWindow } from './fixtures/groveApp'

/** The mode control under the composer, found by the tooltip it carries. */
const MODE_BUTTON_TITLE = 'How much the agent may do without asking (shift+tab)'

/**
 * Open the agent pane on a session of its own.
 *
 * Setup goes through the API on purpose — getting a pane on screen is not what
 * these tests are about, and clicking through the rail to reach it would make
 * every one of them a test of the sidebar as well.
 */
async function openAgentPane(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const view = window as unknown as GroveWindow
    const workspace = view.__grove_debug?.store?.selectedWorktree?.path
    const session = await view.workbench.agents.createSession({ workspace, title: 'pane' })

    const sessions = view.__grove_debug?.agentSessions
    await sessions?.refreshList?.()
    await sessions?.open?.(session.id)
    view.__grove_debug?.layout?.ensurePane('agent')
    return session.id
  })
}

test('the mode control opens and offers every mode', async ({ grove }) => {
  await openAgentPane(grove.page)

  const button = grove.page.getByTitle(MODE_BUTTON_TITLE)
  await expect(button).toBeVisible()
  await button.click()

  for (const label of ['Ask', 'Plan', 'Accept edits', 'Bypass']) {
    await expect(grove.page.getByRole('button', { name: label, exact: false })).toBeVisible()
  }
})

test('picking accept-edits in the UI puts the session into it', async ({ grove }) => {
  const sessionId = await openAgentPane(grove.page)

  await grove.page.getByTitle(MODE_BUTTON_TITLE).click()
  await grove.page.getByRole('button', { name: 'Accept edits' }).click()

  // The control has to agree...
  await expect(grove.page.getByTitle(MODE_BUTTON_TITLE)).toContainText('Accept edits')

  // ...and so does the session the main process is gating. This is the pair
  // that used to come apart: the label changed and the session did not.
  const stored = await grove.page.evaluate(async (id) => {
    const view = window as unknown as GroveWindow
    return (await view.workbench.agents.getSession(id)).permissionMode
  }, sessionId)
  expect(stored).toBe('acceptEdits')
})

test('the mode the control shows survives reopening the pane', async ({ grove }) => {
  const sessionId = await openAgentPane(grove.page)

  await grove.page.getByTitle(MODE_BUTTON_TITLE).click()
  await grove.page.getByRole('button', { name: 'Bypass' }).click()
  await expect(grove.page.getByTitle(MODE_BUTTON_TITLE)).toContainText('Bypass')

  // Drop the session from the renderer and load it again, which is what
  // switching worktrees and coming back does.
  await grove.page.evaluate((id) => {
    const sessions = (window as unknown as GroveWindow).__grove_debug?.agentSessions
    sessions?.close?.(id)
    return sessions?.open?.(id)
  }, sessionId)

  await expect(grove.page.getByTitle(MODE_BUTTON_TITLE)).toContainText('Bypass')
})
