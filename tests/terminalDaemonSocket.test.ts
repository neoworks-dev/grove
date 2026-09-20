// The daemon runs under Electron's node, and this is one of the few places
// where the runtime is the subject: bun's `node:net` unlinks a unix socket path
// and takes it rather than failing with EADDRINUSE, so a test of stale-socket
// recovery run under bun passes with the recovery deleted. Everything here goes
// through a real node process for that reason.

import { describe, it, expect, beforeAll } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workspace = mkdtempSync(join(tmpdir(), 'grove-daemon-'))
const driverPath = join(workspace, 'driver.mjs')

const DRIVER = `
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { listenPastStaleSocket } from './listen.mjs'

const [scenario, socketPath] = process.argv.slice(2)
const report = (fields) => { console.log(JSON.stringify(fields)); process.exit(0) }

if (scenario === 'live') {
  const live = createServer()
  await new Promise((resolve) => live.listen(socketPath, resolve))
  const outcome = await listenPastStaleSocket(createServer(), socketPath)
  report({ outcome, liveStillListening: live.listening, socketExists: existsSync(socketPath) })
}

try {
  const outcome = await listenPastStaleSocket(createServer(), socketPath)
  report({ outcome, socketExists: existsSync(socketPath) })
} catch (cause) {
  report({ error: cause.code })
}
`

/** Run one scenario in node, against the real module, and read back what it saw. */
async function drive(scenario: string, socketPath: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['node', driverPath, scenario, socketPath], { stdout: 'pipe' })
  const output = await new Response(child.stdout).text()
  await child.exited
  return JSON.parse(output.trim())
}

function scratchSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'grove-socket-')), 'terminals.sock')
}

/**
 * The socket file a killed daemon leaves behind: a real listening process,
 * taken down with SIGKILL so nothing unlinks the path on its way out.
 */
async function abandonedSocket(socketPath: string): Promise<void> {
  const listener = `require('net').createServer().listen(${JSON.stringify(socketPath)})`
  const child = Bun.spawn(['node', '-e', listener])
  const deadline = Date.now() + 5_000
  while (!existsSync(socketPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  child.kill(9)
  await child.exited
}

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/main/terminals/listen.ts')],
    target: 'node',
    format: 'esm'
  })
  if (!built.success) throw new Error(`could not build listen.ts: ${built.logs.join('\n')}`)
  writeFileSync(join(workspace, 'listen.mjs'), await built.outputs[0].text())
  writeFileSync(driverPath, DRIVER)
})

describe('binding the terminal daemon socket', () => {
  it('listens on a free path', async () => {
    expect(await drive('free', scratchSocketPath())).toMatchObject({ outcome: 'listening' })
  })

  it('takes over the socket a killed daemon left behind', async () => {
    const socketPath = scratchSocketPath()
    await abandonedSocket(socketPath)
    expect(existsSync(socketPath)).toBe(true)

    expect(await drive('stale', socketPath)).toMatchObject({ outcome: 'listening' })
  })

  it('stands down when a daemon is answering on the path', async () => {
    expect(await drive('live', scratchSocketPath())).toEqual({
      outcome: 'taken',
      // Standing down must not unlink the socket the other daemon is serving.
      liveStillListening: true,
      socketExists: true
    })
  })

  it('fails loudly when the path cannot be bound for another reason', async () => {
    const inAbsentDirectory = join(workspace, 'no-such-directory', 'terminals.sock')
    const result = await drive('unbindable', inAbsentDirectory)

    // Which code the platform picks for an unusable path varies; what matters is
    // that it is raised rather than treated as a socket worth unlinking.
    expect(result.error).toBeTruthy()
    expect(result.error).not.toBe('EADDRINUSE')
  })
})
