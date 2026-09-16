// Chat attachments, end to end in the real app.
//
// This is the half a unit test cannot reach: an attachment was stored and
// referenced correctly, and the transcript pointed an <img> at the right URL,
// but the renderer's Content-Security-Policy blocked the scheme serving it.
// Every piece passed its own test and the feature was still broken, so the
// check that matters is whether an image actually loads in the window.

import { test, expect, type GroveWindow } from './fixtures/groveApp'

// A 1×1 PNG, small enough to inline and real enough to decode.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('an attached image loads in the renderer', async ({ grove }) => {
  const outcome = await grove.page.evaluate(async (base64) => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const session = await api.createSession({ title: 'attachment' })
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const blob = await api.uploadBlob(session.id, bytes, 'image/png', 'probe.png')

    const url = `grove-agent://blob/${session.id}/${blob.ref}`
    return new Promise<string>((resolve) => {
      const image = new Image()
      image.onload = () => resolve(`loaded ${image.naturalWidth}x${image.naturalHeight}`)
      image.onerror = () => resolve('blocked')
      image.src = url
    })
  }, PNG_BASE64)

  // "blocked" is what a CSP that omits grove-agent: produces, and it is
  // indistinguishable from a missing file to everything except this assertion.
  expect(outcome).toBe('loaded 1x1')
})

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

test('an image reaches the harness as an attachment, not as dropped text', async ({ grove }) => {
  const sent = await grove.page.evaluate(async (base64) => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const session = await api.createSession({ title: 'attachment delivery' })
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const blob = await api.uploadBlob(session.id, bytes, 'image/png', 'probe.png')

    await api.sendEvents(session.id, [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', ref: blob.ref, mediaType: 'image/png' }
        ]
      }
    ])

    const events = await api.listEvents(session.id)
    const message = events.find((event) => event.type === 'user.message')
    return {
      blocks: message && 'content' in message ? message.content.map((block) => block.type) : [],
      // A harness that cannot take images says so rather than dropping them;
      // the bundled one can, so there should be nothing to report.
      notices: events
        .filter((event) => event.type === 'session.notice')
        .map((event) => ('message' in event ? event.message : ''))
    }
  }, PNG_BASE64)

  expect(sent.blocks).toEqual(['text', 'image'])
  expect(sent.notices.filter((notice) => notice.includes('attachment'))).toEqual([])
})
