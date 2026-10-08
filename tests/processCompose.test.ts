import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { parseConfig, isConfigFile } from '../resources/plugins/grove.process-compose/src/config'
import type { ProcessSpec } from '../resources/plugins/grove.process-compose/src/config'

// Terminals the runner opens are real processes here: the typed command runs
// under bash, its stdout is the terminal's stream, and its exit ends it.
const spawned: { command: string; process: ReturnType<typeof Bun.spawn> }[] = []

mock.module('@grove/plugin-sdk', () => ({
  terminals: {
    async create(options: { command: string }) {
      const process = Bun.spawn(['bash', '-c', options.command], { stdout: 'pipe', stderr: 'pipe' })
      spawned.push({ command: options.command, process })
      return { terminalId: String(spawned.length - 1) }
    },
    async write(terminalId: string, data: string) {
      // Ctrl-C on a pty reaches the whole foreground group: the children too.
      if (data !== '\x03') return
      const { process } = spawned[Number(terminalId)]
      await Bun.$`pkill -INT -P ${process.pid}`.nothrow().quiet()
      process.kill('SIGINT')
    },
    async kill(terminalId: string) {
      spawned[Number(terminalId)].process.kill('SIGKILL')
    },
    async resize() {},
    read(terminalId: string) {
      const { process } = spawned[Number(terminalId)]
      return (async function* () {
        const decoder = new TextDecoder()
        for await (const chunk of process.stdout as ReadableStream<Uint8Array>) {
          yield { data: decoder.decode(chunk) }
        }
        yield { exitCode: await process.exited }
      })()
    }
  }
}))

const { OutputBuffer, ProjectRunner, conditionMet, launchCommand } = await import(
  '../resources/plugins/grove.process-compose/src/runner'
)
const { dependencySummary, formatDuration, restartLabel, rowStatusLabel, skipReason, statusLabel } = await import(
  '../resources/plugins/grove.process-compose/src/page/status'
)
const { lastLine, plainText } = await import('../resources/plugins/grove.process-compose/src/plainText')
type ProcessView = import('../resources/plugins/grove.process-compose/src/messages').ProcessView

function spec(name: string, command: string, extra: Partial<ProcessSpec> = {}): ProcessSpec {
  return { name, command, workingDir: '.', environment: {}, dependsOn: [], disabled: false, ...extra }
}

describe('process-compose config', () => {
  it('recognises the file names process-compose looks for', () => {
    expect(isConfigFile('process-compose.yaml')).toBe(true)
    expect(isConfigFile('apps/web/process-compose.yml')).toBe(true)
    expect(isConfigFile('docker-compose.yaml')).toBe(false)
  })

  it('reads commands, environment, working dirs and dependencies', () => {
    const config = parseConfig(
      'services/process-compose.yaml',
      [
        'environment:',
        '  - SHARED=1',
        'processes:',
        '  db:',
        '    command: postgres',
        '    environment:',
        '      - PORT=5432',
        '  api:',
        '    command: bun run dev',
        '    working_dir: ./api',
        '    environment: { SHARED: 2 }',
        '    depends_on:',
        '      db:',
        '        condition: process_healthy',
        '  off:',
        '    command: true',
        '    disabled: true'
      ].join('\n')
    )
    const [db, api, off] = config.processes
    expect(db).toEqual(
      spec('db', 'postgres', { workingDir: 'services', environment: { SHARED: '1', PORT: '5432' } })
    )
    expect(api.workingDir).toBe('services/./api')
    expect(api.environment).toEqual({ SHARED: '2' })
    expect(api.dependsOn).toEqual([{ name: 'db', condition: 'process_healthy' }])
    expect(off.disabled).toBe(true)
  })

  it('says what is wrong with a file it cannot use', () => {
    expect(() => parseConfig('p.yaml', 'version: "0.5"')).toThrow('no "processes" section')
    expect(() => parseConfig('p.yaml', '- a list')).toThrow('expected a mapping')
  })
})

describe('process-compose output', () => {
  it('drops the shell prompt and echo before the start marker, even split across chunks', () => {
    const buffer = new OutputBuffer()
    expect(buffer.push("~/repo $ exec sh -c 'printf \\137\\137grove_pc_start…'\r\n__grove_pc_")).toBe('')
    expect(buffer.push('start__\r\nhello\r\n')).toBe('hello\r\n')
    expect(buffer.push('\x1b[32mworld\x1b[0m')).toBe('\x1b[32mworld\x1b[0m')
    expect(buffer.value).toBe('hello\r\n\x1b[32mworld\x1b[0m')
  })

  it('shows its own notes even when the command never started', () => {
    const buffer = new OutputBuffer()
    buffer.note('could not open a terminal')
    expect(buffer.value).toContain('could not open a terminal')
  })

  it('forgets what was shown when discarded, and keeps showing what comes after', () => {
    const buffer = new OutputBuffer()
    buffer.push('__grove_pc_start__\r\nold\r\n')
    buffer.discard()
    expect(buffer.value).toBe('')
    expect(buffer.push('new\r\n')).toBe('new\r\n')
    expect(buffer.value).toBe('new\r\n')
  })
})

describe('process-compose list labels', () => {
  /** A process view with only what a test cares about set. */
  function processView(extra: Partial<ProcessView>): ProcessView {
    return {
      name: 'api',
      command: 'air',
      workingDir: '.',
      dependsOn: [],
      environment: {},
      disabled: false,
      status: 'idle',
      exitCode: null,
      startedAt: null,
      restarts: 0,
      blockedBy: null,
      ...extra
    }
  }

  it('says nothing for a process that never ran, and its uptime while it runs', () => {
    expect(rowStatusLabel(processView({ status: 'idle' }), 0)).toBe('')
    expect(rowStatusLabel(processView({ status: 'disabled' }), 0)).toBe('')
    expect(rowStatusLabel(processView({ status: 'running', startedAt: 1_000 }), 185_000)).toBe('up 3m 4s')
    expect(statusLabel(processView({ status: 'completed', exitCode: 0 }))).toBe('done')
    expect(statusLabel(processView({ status: 'failed', exitCode: 1 }))).toBe('exit 1')
  })

  it('reads durations as their two largest units', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe('2h 5m')
    expect(formatDuration((27 * 60) * 60_000)).toBe('1d 3h')
    expect(formatDuration(-5)).toBe('0s')
  })

  it('names two dependencies and counts the rest', () => {
    const dependsOn = ['redis', 'surrealdb', 'nats', 'minio'].map((name) => ({
      name,
      condition: 'process_healthy'
    }))
    expect(dependencySummary(dependsOn.slice(0, 1))).toBe('after redis')
    expect(dependencySummary(dependsOn)).toBe('after redis, surrealdb +2')
  })

  it('marks restarts only once there were some', () => {
    expect(restartLabel(processView({ restarts: 0 }))).toBe('')
    expect(restartLabel(processView({ restarts: 2 }))).toBe('↻2')
  })

  it('says which dependency kept a skipped process from starting, and what became of it', () => {
    const caddy = processView({ name: 'caddy', status: 'failed', exitCode: 1 })
    const web = processView({ name: 'web', status: 'skipped', blockedBy: 'caddy' })
    expect(skipReason(web, [caddy, web])).toBe('caddy failed')
    expect(skipReason(processView({ status: 'skipped', blockedBy: 'gone' }), [])).toBe("gone can't be met")
    expect(skipReason(caddy, [caddy, web])).toBe('')
  })
})

describe('process-compose plain text', () => {
  it('drops colours and titles, and keeps what a redrawn line last said', () => {
    const output = '\x1b]0;caddy\x07\x1b[34mINFO\x1b[0m ready\r\nloading 10%\rloading 100%\r\n'
    expect(plainText(output)).toBe('INFO ready\nloading 100%\n')
  })

  it('finds the last line that says anything', () => {
    expect(lastLine('first\r\n\x1b[31mError: bad config\x1b[0m\r\n\r\n')).toBe('Error: bad config')
    expect(lastLine('\r\n  \r\n')).toBe('')
  })
})

describe('process-compose launch command', () => {
  const tricky = spec('web', `echo "$GREETING" from $(basename "$PWD")`, {
    workingDir: 'sub dir',
    environment: { GREETING: "it's \"quoted\" $HOME", 'BAD-NAME': 'skipped' }
  })

  for (const shell of ['sh', 'bash', 'fish']) {
    it(`runs the same under ${shell}`, async () => {
      if (!Bun.which(shell)) return
      const dir = `${import.meta.dir}/../test-results/pc-${shell}`
      await Bun.$`mkdir -p ${dir}/${'sub dir'}`.quiet()
      const process = Bun.spawn([shell, '-c', launchCommand(tricky)], { cwd: dir, stdout: 'pipe' })
      const output = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(output).toBe(`__grove_pc_start__\nit's "quoted" $HOME from sub dir\n`)
    })
  }
})

describe('process-compose dependencies', () => {
  beforeEach(() => {
    spawned.length = 0
  })

  it('maps each condition onto what has happened to the dependency', () => {
    expect(conditionMet('process_started', 'running')).toBe('ready')
    expect(conditionMet('process_started', 'waiting')).toBe('wait')
    expect(conditionMet('process_completed', 'failed')).toBe('ready')
    expect(conditionMet('process_completed_successfully', 'failed')).toBe('never')
    expect(conditionMet('process_completed_successfully', 'completed')).toBe('ready')
    expect(conditionMet('process_healthy', 'stopped')).toBe('never')
  })

  it('starts processes in order, skips what can no longer run, and records exits', async () => {
    const events: string[] = []
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => (settle = resolve))
    const runner = new ProjectRunner(
      'wt',
      'process-compose.yaml',
      [
        spec('migrate', 'echo migrated'),
        spec('api', 'echo api up', {
          dependsOn: [{ name: 'migrate', condition: 'process_completed_successfully' }]
        }),
        spec('broken', 'exit 3'),
        spec('after-broken', 'echo never', {
          dependsOn: [{ name: 'broken', condition: 'process_completed_successfully' }]
        }),
        spec('off', 'echo off', { disabled: true })
      ],
      {
        onChange: () => {
          if (!runner.active) settle()
        },
        onOutput: (name, data) => events.push(`${name}: ${data.trim()}`),
        onOutputReset: () => {}
      }
    )
    runner.startAll()
    await settled

    const status = (name: string) => runner.processes.get(name)?.status
    expect(status('migrate')).toBe('completed')
    expect(status('api')).toBe('completed')
    expect(status('broken')).toBe('failed')
    expect(runner.processes.get('broken')?.exitCode).toBe(3)
    expect(status('after-broken')).toBe('skipped')
    expect(runner.processes.get('after-broken')?.blockedBy).toBe('broken')
    expect(status('off')).toBe('disabled')
    expect(events.indexOf('migrate: migrated')).toBeLessThan(events.indexOf('api: api up'))
    expect(spawned).toHaveLength(3)
  })

  it('stops a running process with ctrl-c', async () => {
    let stopped: () => void = () => {}
    const done = new Promise<void>((resolve) => (stopped = resolve))
    const runner = new ProjectRunner('wt', 'p.yaml', [spec('server', 'sleep 30')], {
      onChange: () => {
        if (runner.processes.get('server')?.status === 'stopped') stopped()
      },
      onOutput: () => {},
      onOutputReset: () => {}
    })
    runner.start('server')
    await Bun.sleep(100)
    await runner.stop('server')
    await done
    expect(runner.active).toBe(false)
  })

  it('records when a run started and counts restarts until the next Start all', async () => {
    const runner = new ProjectRunner('wt', 'p.yaml', [spec('server', 'sleep 30')], {
      onChange: () => {},
      onOutput: () => {},
      onOutputReset: () => {}
    })
    const before = Date.now()
    runner.start('server')
    await Bun.sleep(100)
    const server = runner.processes.get('server')
    expect(server?.startedAt).toBeGreaterThanOrEqual(before)
    expect(server?.runs).toBe(1)
    await runner.restart('server')
    await Bun.sleep(100)
    expect(server?.runs).toBe(2)
    await runner.stopAll()
    runner.startAll()
    await Bun.sleep(100)
    expect(server?.runs).toBe(1)
    await runner.stopAll()
  })

  it('clears a process\'s output and tells the pages to start over', () => {
    const resets: string[] = []
    const runner = new ProjectRunner('wt', 'p.yaml', [spec('server', 'true')], {
      onChange: () => {},
      onOutput: () => {},
      onOutputReset: (name) => resets.push(name)
    })
    runner.processes.get('server')?.output.note('earlier output')
    runner.clearOutput('server')
    expect(runner.processes.get('server')?.output.value).toBe('')
    expect(resets).toEqual(['server'])
  })
})
