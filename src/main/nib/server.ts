// The embedded nib agent server.
//
// grove runs nib as a child process for the lifetime of the app and talks to it
// over a unix socket, so nothing agent-related is on the network and no port has
// to be negotiated. The server owns session persistence, extensions, skills and
// the provider connection; grove owns the UI and the review flow on top of it.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm, readdir, copyFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import {
  bundledNibExtensionsDir,
  nibDataDir,
  nibLaunch,
  nibSocketPath,
  type NibLaunch
} from './paths'
import { nibRequest } from './transport'
import type { NibEndpoint, NibStatus } from '../../shared/types'

const HEALTH_TIMEOUT_MS = 20_000
const HEALTH_INTERVAL_MS = 100
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 30_000

export interface NibServerEvents {
  // The server is up and answering. Fires again after every restart, so
  // subscribers know to re-establish their streams.
  onReady: (endpoint: NibEndpoint) => void
  // The child went away unexpectedly; a restart is already scheduled.
  onExit: (reason: string) => void
}

export interface NibServerOptions {
  // `workbench.nibPath`, used to find the source checkout in development.
  configuredPath: () => string | undefined
  events: NibServerEvents
}

export class NibServer {
  private child: ChildProcess | null = null
  private currentEndpoint: NibEndpoint | null = null
  private launch: NibLaunch | null = null
  private starting: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0
  private lastError: string | null = null
  private stopped = false

  constructor(private options: NibServerOptions) {}

  /**
   * Start the server, or join the start already in flight. Safe to call from
   * anywhere that needs nib to be up — the first caller does the work.
   */
  start(): Promise<void> {
    if (this.child && this.currentEndpoint) return Promise.resolve()
    if (this.starting) return this.starting

    this.stopped = false
    this.starting = this.spawnAndWait().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Connection details, or null while the server is down. */
  endpoint(): NibEndpoint | null {
    return this.currentEndpoint
  }

  status(): NibStatus {
    return {
      running: this.child !== null && this.currentEndpoint !== null,
      pid: this.child?.pid ?? null,
      endpoint: this.currentEndpoint,
      source: this.launch?.source ?? null,
      error: this.lastError
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    this.currentEndpoint = null
    if (!child) return

    child.kill('SIGTERM')
    await this.clearSocket()
  }

  // ── Starting ────────────────────────────────────────────────────

  private async spawnAndWait(): Promise<void> {
    const launch = nibLaunch(this.options.configuredPath())
    if (!launch) {
      this.lastError = missingMessage()
      throw new Error(this.lastError)
    }
    this.launch = launch

    await this.prepareDataDir()
    const endpoint = await this.reserveEndpoint()
    const child = spawn(launch.command, [...launch.args, ...listenArgs(endpoint), ...dataArgs()], {
      cwd: launch.cwd,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    this.child = child
    this.watch(child)

    const ready = await this.waitForHealth(endpoint, child)
    if (!ready) {
      this.lastError = `nib did not become healthy on ${describe(endpoint)}`
      child.kill('SIGTERM')
      this.child = null
      throw new Error(this.lastError)
    }

    this.currentEndpoint = endpoint
    this.lastError = null
    this.restartAttempts = 0
    this.options.events.onReady(endpoint)
  }

  /**
   * Copy grove's own extensions into nib's data dir. Extensions there are global
   * rather than per-project, which is what makes them trusted without a prompt.
   */
  private async prepareDataDir(): Promise<void> {
    const target = join(nibDataDir(), 'extensions')
    await mkdir(target, { recursive: true })

    const source = bundledNibExtensionsDir()
    const entries = await readdir(source).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue
      await copyFile(join(source, entry), join(target, entry))
    }
  }

  private async reserveEndpoint(): Promise<NibEndpoint> {
    // nib binds unix sockets only; Windows gets a loopback port instead.
    if (process.platform === 'win32') {
      return { host: '127.0.0.1', port: await freePort() }
    }
    const socketPath = nibSocketPath()
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    // nib removes a stale socket itself, but a leftover file from a hard kill
    // would otherwise make the health check talk to nothing.
    await rm(socketPath, { force: true })
    return { socketPath }
  }

  private async waitForHealth(endpoint: NibEndpoint, child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return false
      if (await isHealthy(endpoint)) return true
      await sleep(HEALTH_INTERVAL_MS)
    }
    return false
  }

  // ── Staying up ──────────────────────────────────────────────────

  private watch(child: ChildProcess): void {
    child.on('error', (cause: Error) => {
      this.lastError = `nib failed to start: ${cause.message}`
      console.error(`[nib] ${this.lastError}`)
    })

    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.currentEndpoint = null
      if (this.stopped) return

      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      this.lastError = `nib stopped unexpectedly (${reason})`
      console.error(`[nib] ${this.lastError}`)
      this.options.events.onExit(reason)
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS)
    this.restartAttempts += 1

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch((error: Error) => {
        console.error(`[nib] restart failed: ${error.message}`)
        this.scheduleRestart()
      })
    }, delay)
  }

  private async clearSocket(): Promise<void> {
    if (process.platform === 'win32') return
    await rm(nibSocketPath(), { force: true }).catch(() => {})
  }
}

function listenArgs(endpoint: NibEndpoint): string[] {
  if (endpoint.socketPath) return ['--socket', endpoint.socketPath]
  return ['--host', endpoint.host ?? '127.0.0.1', '--port', String(endpoint.port)]
}

function dataArgs(): string[] {
  return ['--data-dir', nibDataDir()]
}

function describe(endpoint: NibEndpoint): string {
  if (endpoint.socketPath) return endpoint.socketPath
  return `${endpoint.host}:${endpoint.port}`
}

async function isHealthy(endpoint: NibEndpoint): Promise<boolean> {
  try {
    const response = await nibRequest(endpoint, { method: 'GET', path: '/v1/health' })
    response.resume()
    return response.statusCode === 200
  } catch {
    return false
  }
}

/** Ask the OS for an unused port, then hand it straight to nib. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function missingMessage(): string {
  return (
    'nib runtime missing — set workbench.nibPath (or GROVE_NIB) to a nib checkout, ' +
    'or run `bun scripts/build-nib.ts` for a packaged build'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
