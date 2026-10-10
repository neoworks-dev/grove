// Output of the commands agents run, streamed so the user can watch them.
//
// Three parts: the hub that holds what each command printed and passes it on;
// the helper for harnesses that report everything-so-far rather than what is
// new; and grove mode's own shell tool, which streams into the hub as it runs.

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { addedOutput, ShellOutputHub } from '../src/main/agents/shellOutput'
import { commandResult, shellTool } from '../src/main/agents/tools/shellTool'
import type { GroveToolContext } from '../src/main/agents/harness'
import type { ShellOutputUpdate } from '../src/shared/agents'

/** A hub that records what it publishes. */
function recordingHub(): { hub: ShellOutputHub; updates: ShellOutputUpdate[] } {
  const updates: ShellOutputUpdate[] = []
  return { hub: new ShellOutputHub((update) => updates.push(update)), updates }
}

describe('the output hub', () => {
  test('passes output on in batches, and says when the command is done', async () => {
    const { hub, updates } = recordingHub()
    const sink = hub.sinkFor('s1')

    sink.begin('t1')
    sink.append('t1', 'one\n')
    sink.append('t1', 'two\n')
    await Bun.sleep(80)
    sink.end('t1')

    expect(updates).toEqual([
      { sessionId: 's1', toolUseId: 't1', text: '', running: true, background: false },
      { sessionId: 's1', toolUseId: 't1', text: 'one\ntwo\n', running: true, background: false },
      { sessionId: 's1', toolUseId: 't1', text: '', running: false, background: false }
    ])
  })

  test('a view opening mid-run gets everything so far', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')
    sink.append('t1', 'building…\n')

    expect(hub.snapshot('s1')).toEqual([
      { toolUseId: 't1', text: 'building…\n', running: true, background: false }
    ])
    expect(hub.snapshot('s2')).toEqual([])
  })

  test('drops a command once its result is in and it has exited', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')
    sink.end('t1')

    hub.settle('s1', 't1')

    expect(hub.snapshot('s1')).toEqual([])
  })

  test('keeps a command sent to the background until it exits', () => {
    const { hub } = recordingHub()
    const sink = hub.sinkFor('s1')
    sink.begin('t1')

    hub.settle('s1', 't1')
    sink.append('t1', 'still going\n')

    expect(hub.snapshot('s1')).toEqual([
      { toolUseId: 't1', text: 'still going\n', running: true, background: true }
    ])
    sink.end('t1')
    expect(hub.snapshot('s1')).toEqual([])
  })

  test('marks a command sent to the background with Ctrl+B, so the user can stop it later', () => {
    const { hub, updates } = recordingHub()
    hub.sinkFor('s1').begin('t1', () => {}, () => {})

    expect(hub.background('s1')).toBe(true)

    expect(updates.at(-1)).toEqual({
      sessionId: 's1',
      toolUseId: 't1',
      text: '',
      running: true,
      background: true
    })
    expect(hub.snapshot('s1')[0].background).toBe(true)
  })

  test('interrupts a running command through the harness', () => {
    const { hub } = recordingHub()
    let interrupted = 0
    hub.sinkFor('s1').begin('t1', () => {
      interrupted += 1
    })

    expect(hub.interrupt('s1', 't1')).toBe(true)
    expect(hub.interrupt('s1', 'nope')).toBe(false)
    expect(interrupted).toBe(1)
  })
})

describe('output reported as everything so far', () => {
  test('passes on only what is new', () => {
    expect(addedOutput('', 'a\n')).toBe('a\n')
    expect(addedOutput('a\n', 'a\nb\n')).toBe('a\nb\n'.slice(2))
  })

  test('finds the new part after the front was trimmed', () => {
    const previous = `${'x'.repeat(400)}line 41\n`
    const next = `${'x'.repeat(250)}line 41\nline 42\n`
    expect(addedOutput(previous, next)).toBe('line 42\n')
  })
})

describe("grove mode's shell", () => {
  /** A tool context whose live output lands in the given hub. */
  function contextFor(hub: ShellOutputHub): GroveToolContext {
    return {
      sessionId: 's1',
      workspaceRoot: tmpdir(),
      surface: () => {},
      show: () => {},
      toolCallId: 't1',
      shellOutput: hub.sinkFor('s1')
    }
  }

  test('streams what the command prints to the call it belongs to', async () => {
    const { hub } = recordingHub()
    const result = await shellTool().execute({ command: 'echo one; echo two >&2' }, contextFor(hub))

    expect(result).toEqual({ content: 'one\ntwo', isError: false })
    expect(hub.snapshot('s1')).toEqual([
      { toolUseId: 't1', text: 'one\ntwo\n', running: false, background: false }
    ])
  })

  test('runs in the working directory and reports a failing exit code', async () => {
    const { hub } = recordingHub()
    const result = await shellTool().execute({ command: 'pwd; exit 3' }, contextFor(hub))

    expect(result.content).toBe(`${tmpdir()}\n[Exit code 3.]`)
    expect(result.isError).toBe(true)
  })

  test('stops a command that runs past its timeout', async () => {
    const { hub } = recordingHub()
    const result = await shellTool().execute({ command: 'sleep 5', timeout: 1 }, contextFor(hub))

    expect(result.content).toBe('[Stopped after 1s.]')
    expect(result.isError).toBe(true)
  })

  // Stands in for a tool that colours only when told to, as one writing to a
  // pipe does.
  const COLOURS_WHEN_FORCED =
    'if [ -n "$FORCE_COLOR" ]; then printf "\\033[31mfailed\\033[0m\\n"; else echo failed; fi'

  test('asks the command for colour, and streams the colour to the terminal', async () => {
    const { hub } = recordingHub()
    await shellTool().execute({ command: COLOURS_WHEN_FORCED }, contextFor(hub))

    expect(hub.snapshot('s1')[0].text).toBe('\u001b[31mfailed\u001b[0m\n')
  })

  test('hands the model the output without its escapes', async () => {
    const { hub } = recordingHub()
    const result = await shellTool().execute({ command: COLOURS_WHEN_FORCED }, contextFor(hub))

    expect(result.content).toBe('failed')
  })

  test('strips cursor and title sequences as well as colour', () => {
    const output = '\u001b]0;title\u0007\u001b[2K\u001b[1;32mok\u001b(B\u001b[m done'

    expect(commandResult(output, 0, null, false, 120).content).toBe('ok done')
  })

  test('hands the model the start and end of a long run, not all of it', () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n')
    const result = commandResult(lines, 0, null, false, 120)

    expect(result.content.startsWith('line 0\n')).toBe(true)
    expect(result.content.endsWith('line 4999')).toBe(true)
    expect(result.content).toContain('lines cut')
    expect(result.content.length).toBeLessThan(lines.length)
  })
})

describe('commands in the background', () => {
  /** A tool context that records what the agent is told after its call returned. */
  function notifyingContext(hub: ShellOutputHub): {
    context: GroveToolContext
    told: () => Promise<{ label: string; text: string }>
  } {
    let resolveTold: (message: { label: string; text: string }) => void = () => {}
    const told = new Promise<{ label: string; text: string }>((resolve) => {
      resolveTold = resolve
    })
    const context: GroveToolContext = {
      sessionId: 's1',
      workspaceRoot: tmpdir(),
      surface: () => {},
      show: () => {},
      toolCallId: 't1',
      shellOutput: hub.sinkFor('s1'),
      notify: (label, text) => resolveTold({ label, text })
    }
    return { context, told: () => told }
  }

  test('run_in_background returns at once and tells the agent when the command exits', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    const result = await shellTool().execute(
      { command: 'sleep 0.3; echo built; exit 2', run_in_background: true },
      context
    )
    expect(result.content).toContain('Started in the background')
    expect(hub.snapshot('s1')[0].running).toBe(true)

    const message = await told()
    expect(message.label).toBe('Background command finished')
    expect(message.text).toBe('$ sleep 0.3; echo built; exit 2\nbuilt\n[Exit code 2.]')
  })

  test('Ctrl+B returns the call of a running command, which goes on to finish', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    const call = shellTool().execute({ command: 'sleep 0.3; echo done' }, context)
    await Bun.sleep(50)
    expect(hub.background('s1')).toBe(true)

    const result = await call
    expect(result.content).toContain('The user sent the command to the background')
    expect((await told()).text).toBe('$ sleep 0.3; echo done\ndone')
  })

  test('a backgrounded command without a timeout of its own runs on', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    const call = shellTool().execute({ command: 'sleep 1.5; echo survived' }, context)
    await Bun.sleep(50)
    hub.background('s1')
    await call

    expect((await told()).text).toBe('$ sleep 1.5; echo survived\nsurvived')
  })

  test('a backgrounded command is stopped when its own timeout runs out', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    const call = shellTool().execute({ command: 'sleep 3; echo survived', timeout: 1 }, context)
    await Bun.sleep(50)
    hub.background('s1')
    await call

    expect((await told()).text).toBe('$ sleep 3; echo survived\n[Stopped after 1s.]')
  })

  test('run_in_background with a timeout is stopped when it runs out', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    await shellTool().execute({ command: 'sleep 3', timeout: 1, run_in_background: true }, context)

    expect((await told()).text).toBe('$ sleep 3\n[Stopped after 1s.]')
  })

  test('Ctrl+B with nothing running moves nothing', () => {
    const { hub } = recordingHub()
    expect(hub.background('s1')).toBe(false)
  })

  test('a session going away stops what it left running', async () => {
    const { hub } = recordingHub()
    const { context, told } = notifyingContext(hub)

    await shellTool().execute({ command: 'sleep 30', run_in_background: true }, context)
    hub.forgetSession('s1')

    expect((await told()).text).toContain('[Killed by SIGINT.]')
  })
})
