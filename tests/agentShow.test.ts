// The tools an agent uses to point the user at things.
//
// They only ask the renderer to show a target, so what matters here is that the
// target they ask for is the one the model meant — whatever it wrote into the
// arguments — and that a pane the renderer does not have is refused with the
// list of the ones it does.

import { describe, expect, test } from 'bun:test'
import { groveTools } from '../src/main/agents/tools'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { CodeLocation, ShowTarget } from '../src/shared/agents'

const PANES = [
  { id: 'terminal', title: 'Terminal' },
  { id: 'changes', title: 'Git changes' }
]

function toolNamed(name: string): GroveTool {
  const tools = groveTools({
    chat: {} as never,
    roster: { harnessIds: () => ['claude'] } as never,
    notes: {} as never,
    screen: { paneTypes: () => PANES }
  })
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`${name} is not offered`)
  return tool
}

interface Surface {
  surfaceId: string
  slot: string
  view: unknown
}

/** A tool context that records what the tool asked the renderer to show. */
function recordingContext(): { context: GroveToolContext; shown: ShowTarget[]; surfaces: Surface[] } {
  const shown: ShowTarget[] = []
  const surfaces: Surface[] = []
  const context: GroveToolContext = {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    surface: (surfaceId, slot, view) => surfaces.push({ surfaceId, slot, view }),
    show: (target) => shown.push(target)
  }
  return { context, shown, surfaces }
}

/** The locations a card view holds. */
function locationsIn(view: unknown): CodeLocation[] {
  return (view as { locations: CodeLocation[] }).locations
}

describe('showing the user something', () => {
  test('never stops the turn on an approval', () => {
    for (const name of ['show_locations', 'show_diff', 'show_github_item', 'open_pane']) {
      expect(toolNamed(name).policy).toBe('allow')
    }
  })

  test('lists locations as a card in the conversation, opening nothing', async () => {
    const { context, shown, surfaces } = recordingContext()

    const result = await toolNamed('show_locations').execute(
      {
        title: 'Where tokens are checked',
        locations: [
          { path: 'src/auth.ts', startLine: 42, endLine: 48, note: 'Expiry compared with <.' },
          { path: 'src/session.ts' }
        ]
      },
      context
    )

    expect(result.isError).toBeUndefined()
    expect(shown).toEqual([])
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].slot).toBe('transcript')
    expect(surfaces[0].view).toMatchObject({
      kind: 'locations',
      title: 'Where tokens are checked',
      locations: [
        { path: 'src/auth.ts', startLine: 42, endLine: 48, note: 'Expiry compared with <.' },
        { path: 'src/session.ts' }
      ]
    })
  })

  test('is offered up front, since it is used without being asked for', () => {
    expect(toolNamed('show_locations').alwaysLoad).toBe(true)
  })

  test('each call gets a card of its own', async () => {
    const { context, surfaces } = recordingContext()

    await toolNamed('show_locations').execute({ locations: [{ path: 'a.ts' }] }, context)
    await toolNamed('show_locations').execute({ locations: [{ path: 'b.ts' }] }, context)

    expect(surfaces[0].surfaceId).not.toBe(surfaces[1].surfaceId)
  })

  test('a range without an end, or ending before it starts, is one line', async () => {
    const { context, surfaces } = recordingContext()

    await toolNamed('show_locations').execute(
      { locations: [{ path: 'a.ts', startLine: 7 }, { path: 'a.ts', startLine: 7, endLine: 3 }] },
      context
    )

    expect(locationsIn(surfaces[0].view)).toEqual([
      { path: 'a.ts', startLine: 7, endLine: 7 },
      { path: 'a.ts', startLine: 7, endLine: 7 }
    ])
  })

  test('keeps line annotations, dropping the ones without a line or text', async () => {
    const { context, surfaces } = recordingContext()

    await toolNamed('show_locations').execute(
      {
        locations: [
          {
            path: 'a.ts',
            startLine: 10,
            endLine: 20,
            annotations: [
              { line: 12, text: 'Off by one here.' },
              { line: 0, text: 'No line.' },
              { line: 14, text: '  ' }
            ]
          }
        ]
      },
      context
    )

    expect(locationsIn(surfaces[0].view)[0].annotations).toEqual([
      { line: 12, text: 'Off by one here.' }
    ])
  })

  test('cuts a note longer than two or three sentences', async () => {
    const { context, surfaces } = recordingContext()

    await toolNamed('show_locations').execute(
      { locations: [{ path: 'a.ts', note: 'word '.repeat(100) }] },
      context
    )

    const note = locationsIn(surfaces[0].view)[0].note ?? ''
    expect(note.length).toBe(240)
    expect(note.endsWith('…')).toBe(true)
  })

  test('drops entries without a path, and refuses a call left with none', async () => {
    const { context, surfaces } = recordingContext()

    const result = await toolNamed('show_locations').execute(
      { locations: [{ startLine: 3 }, 'nope'] },
      context
    )

    expect(result.isError).toBe(true)
    expect(surfaces).toEqual([])
  })

  test('shows the whole diff, or one file of it', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('show_diff').execute({}, context)
    await toolNamed('show_diff').execute({ path: 'src/a.ts' }, context)

    expect(shown).toEqual([{ kind: 'diff' }, { kind: 'diff', path: 'src/a.ts' }])
  })

  test('carries a note on what to look at', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('show_diff').execute({ path: 'a.ts', note: 'The retry loop is new.' }, context)
    await toolNamed('open_pane').execute({ pane: 'terminal', note: '  ' }, context)

    expect(shown).toEqual([
      { kind: 'diff', path: 'a.ts', note: 'The retry loop is new.' },
      { kind: 'pane', pane: 'terminal' }
    ])
  })

  test('opens an issue by number', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('show_github_item').execute({ number: 212 }, context)

    expect(shown).toEqual([{ kind: 'github', number: 212 }])
  })

  test('opens a pane the renderer has', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('open_pane').execute({ pane: 'terminal' }, context)

    expect(shown).toEqual([{ kind: 'pane', pane: 'terminal' }])
  })

  test('refuses a pane it does not have, and lists the ones it does', async () => {
    const { context, shown } = recordingContext()

    const result = await toolNamed('open_pane').execute({ pane: 'browser' }, context)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('- terminal: Terminal')
    expect(shown).toEqual([])
  })

  test('lists the panes when none is named', async () => {
    const { context, shown } = recordingContext()

    const result = await toolNamed('open_pane').execute({}, context)

    expect(result.content).toBe('Panes:\n- terminal: Terminal\n- changes: Git changes')
    expect(shown).toEqual([])
  })
})
