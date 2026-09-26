// The tools an agent uses to put something in front of the user.
//
// They only ask the renderer to show a target, so what matters here is that the
// target they ask for is the one the model meant — whatever it wrote into the
// arguments — and that a pane the renderer does not have is refused with the
// list of the ones it does.

import { describe, expect, test } from 'bun:test'
import { groveTools } from '../src/main/agents/tools'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { ShowTarget } from '../src/shared/agents'

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

/** A tool context that records what the tool asked the renderer to show. */
function recordingContext(): { context: GroveToolContext; shown: ShowTarget[] } {
  const shown: ShowTarget[] = []
  const context: GroveToolContext = {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    surface: () => {},
    openFiles: () => {},
    show: (target) => shown.push(target)
  }
  return { context, shown }
}

describe('showing the user something', () => {
  test('never stops the turn on an approval', () => {
    for (const name of ['highlight_code', 'show_diff', 'show_github_item', 'open_pane']) {
      expect(toolNamed(name).policy).toBe('allow')
    }
  })

  test('marks a range with its note', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('highlight_code').execute(
      { path: 'src/a.ts', startLine: 12, endLine: 18, note: 'This loop never ends' },
      context
    )

    expect(shown).toEqual([
      { kind: 'code', path: 'src/a.ts', startLine: 12, endLine: 18, note: 'This loop never ends' }
    ])
  })

  test('a range without an end, or ending before it starts, is one line', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('highlight_code').execute({ path: 'a.ts', startLine: 7 }, context)
    await toolNamed('highlight_code').execute({ path: 'a.ts', startLine: 7, endLine: 3 }, context)

    expect(shown).toEqual([
      { kind: 'code', path: 'a.ts', startLine: 7, endLine: 7 },
      { kind: 'code', path: 'a.ts', startLine: 7, endLine: 7 }
    ])
  })

  test('a mark without a usable line shows nothing', async () => {
    const { context, shown } = recordingContext()

    const result = await toolNamed('highlight_code').execute({ path: 'a.ts', startLine: 0 }, context)

    expect(result.isError).toBe(true)
    expect(shown).toEqual([])
  })

  test('shows the whole diff, or one file of it', async () => {
    const { context, shown } = recordingContext()

    await toolNamed('show_diff').execute({}, context)
    await toolNamed('show_diff').execute({ path: 'src/a.ts' }, context)

    expect(shown).toEqual([{ kind: 'diff' }, { kind: 'diff', path: 'src/a.ts' }])
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
