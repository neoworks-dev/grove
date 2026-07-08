// Process supervisor. Spawns configured shell commands per (worktree, service),
// captures output to a log file (purged on each relaunch), tracks the PID, kills
// on stop, and polls health URLs. Emits status + log events to the renderer.

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, truncate, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  ServiceConfig,
  ServiceRuntime,
  ServiceStatus,
  Worktree,
  WorkbenchConfig
} from '../shared/types'
import { buildWorktreeEnv, substitute, spawnEnv } from './env'

export interface ServiceEvents {
  onStatus: (runtime: ServiceRuntime) => void
  onLog: (worktreeId: string, name: string, line: string) => void
}

interface RunningService {
  child: ChildProcess
  logStream: WriteStream
  healthTimer: NodeJS.Timeout | null
  runtime: ServiceRuntime
}

function logsDir(worktreePath: string): string {
  return join(worktreePath, '.workbench', 'logs')
}

export class ServiceSupervisor {
  private running = new Map<string, RunningService>()

  constructor(private events: ServiceEvents) {}

  private key(worktreeId: string, name: string): string {
    return `${worktreeId}::${name}`
  }

  // Static runtime snapshot for a service that isn't running (status stopped).
  buildIdleRuntime(
    worktree: Worktree,
    name: string,
    service: ServiceConfig,
    ports: number[]
  ): ServiceRuntime {
    const vars = buildWorktreeEnv(worktree, ports)
    const logFile = service.log || `${name}.log`
    return {
      worktreeId: worktree.id,
      name,
      status: 'stopped',
      pid: null,
      previewUrl: service.preview ? substitute(service.preview, vars) : null,
      healthUrl: service.health ? substitute(service.health, vars) : null,
      logPath: join(logsDir(worktree.path), logFile),
      ports
    }
  }

  getRuntime(worktreeId: string, name: string): ServiceRuntime | null {
    return this.running.get(this.key(worktreeId, name))?.runtime ?? null
  }

  private setStatus(entry: RunningService, status: ServiceStatus): void {
    entry.runtime.status = status
    this.events.onStatus({ ...entry.runtime })
  }

  async start(
    worktree: Worktree,
    name: string,
    service: ServiceConfig,
    ports: number[]
  ): Promise<ServiceRuntime> {
    await this.stop(worktree.id, name) // idempotent restart

    const vars = buildWorktreeEnv(worktree, ports)
    const command = substitute(service.command, vars)
    const logFile = service.log || `${name}.log`
    const dir = logsDir(worktree.path)
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, logFile)
    // Purge previous log on relaunch.
    await writeFile(logPath, '', 'utf8').catch(() => truncate(logPath, 0).catch(() => {}))

    const logStream = createWriteStream(logPath, { flags: 'a' })
    const child = spawn(command, {
      cwd: worktree.path,
      env: spawnEnv(vars),
      shell: true,
      detached: false
    })

    const runtime: ServiceRuntime = {
      worktreeId: worktree.id,
      name,
      status: 'starting',
      pid: child.pid ?? null,
      previewUrl: service.preview ? substitute(service.preview, vars) : null,
      healthUrl: service.health ? substitute(service.health, vars) : null,
      logPath,
      ports
    }

    const entry: RunningService = { child, logStream, healthTimer: null, runtime }
    this.running.set(this.key(worktree.id, name), entry)

    this.pipeOutput(entry, worktree.id, name)
    child.on('exit', (code) => this.handleExit(worktree.id, name, code))
    child.on('error', (err) => {
      this.events.onLog(worktree.id, name, `[supervisor] spawn error: ${err.message}`)
      this.handleExit(worktree.id, name, 1)
    })

    this.events.onStatus({ ...runtime })

    if (runtime.healthUrl) {
      this.startHealthPolling(entry)
    } else {
      // No health check configured — treat as running once spawned.
      this.setStatus(entry, 'running')
    }

    return { ...runtime }
  }

  private pipeOutput(entry: RunningService, worktreeId: string, name: string): void {
    const handle = (buffer: Buffer): void => {
      const text = buffer.toString()
      entry.logStream.write(text)
      text
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => this.events.onLog(worktreeId, name, line))
    }
    entry.child.stdout?.on('data', handle)
    entry.child.stderr?.on('data', handle)
  }

  private startHealthPolling(entry: RunningService): void {
    const poll = async (): Promise<void> => {
      const url = entry.runtime.healthUrl
      if (!url) return
      const healthy = await checkHealth(url)
      const next: ServiceStatus = healthy ? 'running' : 'unhealthy'
      if (entry.runtime.status !== next && entry.runtime.status !== 'stopped') {
        this.setStatus(entry, next)
      }
    }
    entry.healthTimer = setInterval(poll, 3000)
    void poll()
  }

  private handleExit(worktreeId: string, name: string, code: number | null): void {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    if (entry.healthTimer) clearInterval(entry.healthTimer)
    entry.logStream.end()
    entry.runtime.status = 'stopped'
    entry.runtime.pid = null
    this.events.onLog(worktreeId, name, `[supervisor] exited with code ${code}`)
    this.events.onStatus({ ...entry.runtime })
    this.running.delete(this.key(worktreeId, name))
  }

  async stop(worktreeId: string, name: string): Promise<void> {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    if (entry.healthTimer) clearInterval(entry.healthTimer)
    const pid = entry.child.pid
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already dead
      }
    }
    // handleExit will fire on the exit event and clean up.
  }

  async stopAllForWorktree(worktreeId: string): Promise<void> {
    const names = [...this.running.keys()]
      .filter((key) => key.startsWith(`${worktreeId}::`))
      .map((key) => key.split('::')[1])
    for (const name of names) {
      await this.stop(worktreeId, name)
    }
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.running.keys()]) {
      const [worktreeId, name] = key.split('::')
      await this.stop(worktreeId, name)
    }
  }
}

// Health check: GET the URL, any 2xx/3xx/4xx response means the port is up.
async function checkHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    return response.status < 500
  } catch {
    return false
  }
}

export function serviceConfigList(config: WorkbenchConfig): Array<[string, ServiceConfig]> {
  return Object.entries(config.services)
}
