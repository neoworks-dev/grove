// The line under the prompt names the permission mode, and follows Shift+Tab.

import { test, expect } from './fixtures/groveApp'

test('the hint line shows the mode and changes when the mode is cycled', async ({ grove }) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  const mode = page.getByTestId('agent-hints-mode')
  await expect(mode).toContainText('Ask mode')

  await page.getByPlaceholder(/^Prompt…/).click()
  await page.keyboard.press('Shift+Tab')
  await expect(mode).not.toContainText('Ask mode')
})
