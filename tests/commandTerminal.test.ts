// A command's terminal, what is read off it for the model, and telling when
// the command is waiting for input. Run on pipes: node-pty's stream breaks
// under bun (an empty read on the pty closes it), so the pty is exercised in
// the app.

import { describe, expect, test } from 'bun:test'
import { spawnOnPipes, type CommandExit, type CommandTerminal } from '../src/main/agents/commandTerminal'
import { ScreenText } from '../src/main/agents/screenText'
import {
  blockedOn,
  epollDescriptors,
  isInputWait,
  isWaitingForInput,
  parseStat,
  pollDescriptors,
  selectDescriptors
} from '../src/main/agents/inputWait'

/** Starts `bash -c command` on pipes, collecting what it prints. */
function start(command: string): { terminal: CommandTerminal; printed: () => string; exited: Promise<CommandExit> } {
  const terminal = spawnOnPipes('bash', ['-c', command], {
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>) },
    cols: 80,
    rows: 24
  })
  let printed = ''
  terminal.onData((text) => {
    printed += text
  })
  const exited = new Promise<CommandExit>((resolve) => terminal.onExit(resolve))
  return { terminal, printed: () => printed, exited }
}

/** Polls until `check` holds, for at most two seconds. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check()) return true
    await Bun.sleep(50)
  }
  return false
}

describe('a command terminal', () => {
  test('takes typed input', async () => {
    const run = start('read answer; echo "got $answer"')
    run.terminal.write('yes\n')
    expect(await run.exited).toEqual({ code: 0, signal: null })
    expect(run.printed()).toBe('got yes\n')
  })

  test('ending its input gives a waiting read end of file', async () => {
    const run = start('if read answer; then echo read; else echo eof; fi')
    run.terminal.endInput()
    await run.exited
    expect(run.printed()).toBe('eof\n')
  })

  test('interrupt stops it as Ctrl+C would', async () => {
    const run = start('sleep 30')
    run.terminal.interrupt()
    expect((await run.exited).signal).toBe('SIGINT')
  })
})

describe('the text the model reads', () => {
  test('is what was on screen: no colour, progress redrawn in place, wrapped lines joined', async () => {
    const screen = new ScreenText(20, 5)
    screen.write('\u001b[31mred\u001b[0m\nprogress 10%\rprogress 100%\n')
    screen.write('x'.repeat(30) + '\nend\n')
    expect(await screen.text()).toBe(`red\nprogress 100%\n${'x'.repeat(30)}\nend`)
    screen.dispose()
  })
})

describe('the terminal the command talks to', () => {
  test('answers what a program asks a terminal: device attributes, cursor position', async () => {
    const screen = new ScreenText(80, 24)
    const replies: string[] = []
    screen.onReply((data) => replies.push(data))
    screen.write('\u001b[0c\u001b[6n')
    await screen.text()
    expect(replies).toEqual(['\u001b[?1;2c', '\u001b[1;1R'])
    screen.dispose()
  })
})

describe('waiting for input', () => {
  test('reads the session and what a process is blocked in out of /proc text', () => {
    expect(parseStat('4242 (my (odd) cmd) S 1 4242 4200 34816 4242 0')).toEqual({ pid: 4242, session: 4200 })
    expect(blockedOn('0 0x3 0x7ffd 0x1 0x0 0x0 0x0 0x7ffd 0x7f', 'x64')).toEqual({ kind: 'read', descriptor: 3 })
    expect(blockedOn('271 0x7ffd10 0x2 0x0 0x0 0x8 0x0 0x7ffd 0x7f', 'x64')).toEqual({
      kind: 'poll',
      address: 0x7ffd10,
      count: 2
    })
    expect(blockedOn('270 0x5 0x7ffd20 0x0 0x0 0x0 0x0 0x7ffd 0x7f', 'x64')).toEqual({
      kind: 'select',
      count: 5,
      address: 0x7ffd20
    })
    expect(blockedOn('232 0x4 0x7ffd 0x400 0xffffffff 0x0 0x0 0x7ffd 0x7f', 'x64')).toEqual({
      kind: 'epoll',
      descriptor: 4
    })
    expect(blockedOn('61 0xffffffff 0x7ffd 0x0 0x0 0x0 0x0 0x7ffd 0x7f', 'x64')).toBeNull()
    expect(blockedOn('running', 'x64')).toBeNull()
  })

  test('reads the descriptors a poll, select or epoll waits on', () => {
    const pollSet = Buffer.alloc(16)
    pollSet.writeInt32LE(0, 0)
    pollSet.writeInt32LE(7, 8)
    expect(pollDescriptors(pollSet)).toEqual([0, 7])
    expect(selectDescriptors(Buffer.from([0b00100001]), 6)).toEqual([0, 5])
    expect(epollDescriptors('pos:\t0\nflags:\t02\ntfd:        0 events:       19 data: 0\ntfd:        9 events: 1 data: 9\n')).toEqual([0, 9])
  })

  test('a wait on the input counts, unless it also watches a socket', () => {
    expect(isInputWait(['/dev/pts/3', 'pipe:[12]'], '/dev/pts/3')).toBe(true)
    expect(isInputWait(['/dev/pts/3', 'socket:[99]'], '/dev/pts/3')).toBe(false)
    expect(isInputWait(['pipe:[12]'], '/dev/pts/3')).toBe(false)
    expect(isInputWait(['socket:[5]'], 'socket:[5]')).toBe(true)
  })

  test.if(process.platform === 'linux')('a command blocked reading its input is waiting', async () => {
    const run = start('sleep 0.2; read answer; echo "got $answer"')
    expect(await isWaitingForInput(run.terminal.pid)).toBe(false)
    expect(await eventually(() => isWaitingForInput(run.terminal.pid))).toBe(true)
    run.terminal.write('ok\n')
    await run.exited
    expect(run.printed()).toBe('got ok\n')
  })

  test.if(process.platform === 'linux')('one reading through a child it started is waiting too', async () => {
    const run = start('cat | head -1')
    expect(await eventually(() => isWaitingForInput(run.terminal.pid))).toBe(true)
    run.terminal.kill()
    await run.exited
  })

  test.if(process.platform === 'linux')('a line editor waiting in select, poll or epoll is waiting', async () => {
    const waits = [
      'python3 -c "import select, sys; select.select([sys.stdin], [], [])"',
      'python3 -c "import select, sys; p = select.poll(); p.register(sys.stdin, select.POLLIN); p.poll()"',
      'python3 -c "import select, sys; e = select.epoll(); e.register(sys.stdin.fileno(), select.EPOLLIN); e.poll()"'
    ]
    for (const command of waits) {
      const run = start(command)
      expect(await eventually(() => isWaitingForInput(run.terminal.pid))).toBe(true)
      run.terminal.kill()
      await run.exited
    }
  })

  test.if(process.platform === 'linux')('a server that also reads its input is not waiting', async () => {
    const run = start(
      'python3 -c "import select, socket, sys; s = socket.socket(); s.bind((\'127.0.0.1\', 0)); s.listen(); select.select([sys.stdin, s], [], [])"'
    )
    await Bun.sleep(400)
    expect(await isWaitingForInput(run.terminal.pid)).toBe(false)
    run.terminal.kill()
    await run.exited
  })

  test.if(process.platform === 'linux')('a command that is only busy is not', async () => {
    const run = start('sleep 30')
    await Bun.sleep(200)
    expect(await isWaitingForInput(run.terminal.pid)).toBe(false)
    run.terminal.kill()
    await run.exited
  })
})
