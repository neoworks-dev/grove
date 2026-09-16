// Chat attachments, end to end in the real app.
//
// This is the half a unit test cannot reach: an attachment was stored and
// referenced correctly, and the transcript pointed an <img> at the right URL,
// but the renderer's Content-Security-Policy blocked the scheme serving it.
// Every piece passed its own test and the feature was still broken, so the
// check that matters is whether an image actually loads in the window.

import { test, expect, startAgentSession, type GroveWindow } from './fixtures/groveApp'

// A 1×1 PNG, small enough to inline and real enough to decode.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('the content security policy allows the scheme that serves attachments', async ({ grove }) => {
  const policy = await grove.page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    return meta?.getAttribute('content') ?? ''
  })

  expect(policy).toContain('img-src')
  // Named explicitly: the policy used to allow grove-nib:, a scheme that no
  // longer exists, which is exactly the kind of rename a broad assertion misses.
  expect(policy).toMatch(/img-src[^;]*grove-agent:/)
  expect(policy).not.toContain('grove-nib:')
})

test('an attached image loads in the renderer', async ({ grove }) => {
  const sessionId = await startAgentSession(grove.page)

  const outcome = await grove.page.evaluate(
    async ({ id, base64 }) => {
      const api = (window as unknown as GroveWindow).workbench.agents
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const blob = await api.uploadBlob(id, bytes, 'image/png', 'probe.png')

      return new Promise<string>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(`loaded ${image.naturalWidth}x${image.naturalHeight}`)
        image.onerror = () => resolve('blocked')
        image.src = `grove-agent://blob/${id}/${blob.ref}`
      })
    },
    { id: sessionId, base64: PNG_BASE64 }
  )

  // "blocked" is what a CSP that omits grove-agent: produces, and it is
  // indistinguishable from a missing file to everything except this assertion.
  expect(outcome).toBe('loaded 1x1')
})

test('an attached image shows up in the transcript', async ({ grove }) => {
  const sessionId = await startAgentSession(grove.page)

  await grove.page.evaluate(
    async ({ id, base64 }) => {
      const api = (window as unknown as GroveWindow).workbench.agents
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const blob = await api.uploadBlob(id, bytes, 'image/png', 'probe.png')
      await api.sendEvents(id, [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', ref: blob.ref, mediaType: 'image/png' }
          ]
        }
      ])
    },
    { id: sessionId, base64: PNG_BASE64 }
  )

  // The message itself, and the attachment rendered beside it rather than
  // dropped on the way to the transcript.
  await expect(grove.page.getByText('what is this?')).toBeVisible()
  const attachment = grove.page.locator('img[src^="grove-agent://blob/"]').first()
  await expect(attachment).toBeVisible()

  // Visible is not the same as decoded — a blocked image still occupies a box.
  const decoded = await attachment.evaluate((node) => (node as HTMLImageElement).naturalWidth > 0)
  expect(decoded).toBe(true)
})
