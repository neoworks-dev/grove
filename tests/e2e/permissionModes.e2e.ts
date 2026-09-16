// Permission modes, end to end in the real app.
//
// The bug these cover was an architectural one: the mode was held in renderer
// memory, so the main process — which is what gates tool calls and raises
// reviews — never saw it. Choosing accept-edits changed what the picker said
// and nothing else. Asserting across the IPC boundary is the only way to catch
// that, because both halves were self-consistent.

import { test, expect, type GroveWindow } from './fixtures/groveApp'

const MODES = ['default', 'plan', 'acceptEdits', 'bypass'] as const

test('choosing a mode stores it on the session, not in the window', async ({ grove }) => {
  const stored = await grove.page.evaluate(async (modes) => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const results: { chosen: string; stored: string }[] = []

    for (const mode of modes) {
      const session = await api.createSession({ title: `mode ${mode}` })
      await api.updateSession(session.id, { permissionMode: mode })
      // Re-read rather than trusting the patch's own answer: this is what a
      // second window, or the same one after a restart, would see.
      const reread = await api.getSession(session.id)
      results.push({ chosen: mode, stored: reread.permissionMode })
    }
    return results
  }, MODES)

  for (const { chosen, stored: actual } of stored) {
    expect(actual).toBe(chosen)
  }
})

test('a new session starts in the asking mode', async ({ grove }) => {
  const mode = await grove.page.evaluate(async () => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const session = await api.createSession({ title: 'fresh' })
    return session.permissionMode
  })

  expect(mode).toBe('default')
})

test('the picker reads the mode back off the session', async ({ grove }) => {
  const reported = await grove.page.evaluate(async () => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const sessions = (window as unknown as GroveWindow).__grove_debug?.agentSessions

    const session = await api.createSession({ title: 'picker' })
    await api.updateSession(session.id, { permissionMode: 'acceptEdits' })
    await sessions?.refreshList?.()
    await sessions?.open?.(session.id)
    return sessions?.modeFor(session.id)
  })

  // The renderer used to answer from its own map, which is why it could report
  // accept-edits for a session the main process was still gating.
  expect(reported).toBe('acceptEdits')
})

test('the mode survives the session being reopened', async ({ grove }) => {
  const afterReopen = await grove.page.evaluate(async () => {
    const api = (window as unknown as GroveWindow).workbench.agents
    const session = await api.createSession({ title: 'persistence' })
    await api.updateSession(session.id, { permissionMode: 'bypass' })

    // Listing goes back to the store on disk, so this is the answer a restart
    // would produce.
    const listed = await api.listSessions()
    return listed.find((entry) => entry.id === session.id)?.permissionMode
  })

  expect(afterReopen).toBe('bypass')
})
