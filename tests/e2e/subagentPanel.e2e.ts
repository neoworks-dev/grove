// The panel under the prompt that lists the session and the agents it started.
//
// A spawned session is made through the API, since a real agent costs tokens; what
// the panel does with it is driven from the keyboard.

import { test, expect, type GroveWindow } from './fixtures/groveApp'

test('the panel lists a spawned agent, opens it with Enter and clears it with x', async ({
  grove
}) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByPlaceholder(/^Prompt…/).click()

  await page.evaluate(async () => {
    const view = window as unknown as GroveWindow
    const [main] = await view.workbench.agents.listSessions()
    await view.workbench.agents.createSession({
      workspace: main.workspaceRoot,
      title: 'Spawned helper',
      labels: { 'grove.parent': main.id }
    })
  })

  const rows = page.getByTestId('subagent-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('Spawned helper')

  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('subagent-panel')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('x')
  await expect(page.getByTestId('subagent-panel')).toBeHidden()
})

test('x on the session itself types into the prompt, and Escape goes back to it', async ({
  grove
}) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  const prompt = page.getByPlaceholder(/^Prompt…/)
  await prompt.click()
  await page.evaluate(async () => {
    const view = window as unknown as GroveWindow
    const [main] = await view.workbench.agents.listSessions()
    await view.workbench.agents.createSession({
      workspace: main.workspaceRoot,
      title: 'Spawned helper',
      labels: { 'grove.parent': main.id }
    })
  })
  await expect(page.getByTestId('subagent-row')).toHaveCount(2)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('x')
  await expect(prompt).toHaveValue('x')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(prompt).toBeFocused()
})
