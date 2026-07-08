// Agent launcher. Agents are named command adapters (claude -p, codex exec, ...).
// Launching = spawn the configured command with cwd = worktree, capture output,
// stream to the Agent pane + a log file. Replaceable backends, no Claude-specific
// coupling. Multiple worktrees may run agents concurrently.

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentConfig, AgentRuntime, Worktree } from '../shared/types'
import { buildWorktreeEnv, substitute, spawnEnv } from './env'

export interface AgentEvents {
  onStatus: (runtime: AgentRuntime) => void
  onLog: (worktreeId: string, name: string, line: string) => void
}

interface RunningAgent {
  child: ChildProcess
  logStream: WriteStream
  runtime: AgentRuntime
}

function logsDir(worktreePath: string): string {
  return join(worktreePath, '.workbench', 'logs')
}

export class AgentManager {
  private running = new Map<string, RunningAgent>()

  constructor(private events: AgentEvents) {}

  private key(worktreeId: string, name: string): string {
    return `${worktreeId}::${name}`
  }

  getRuntime(worktreeId: string, name: string): AgentRuntime | null {
    return this.running.get(this.key(worktreeId, name))?.runtime ?? null
  }

  isRunning(worktreeId: string, name: string): boolean {
    return this.running.has(this.key(worktreeId, name))
  }

  // Launch an agent. `prompt` is appended as a single quoted argument when given.
  async start(
    worktree: Worktree,
    name: string,
    agent: AgentConfig,
    ports: number[],
    prompt?: string
  ): Promise<AgentRuntime> {
    await this.stop(worktree.id, name)

    const vars = buildWorktreeEnv(worktree, ports)
    let command = substitute(agent.command, vars)
    if (prompt && prompt.trim().length > 0) {
      command = `${command} ${shellQuote(prompt)}`
    }

    const dir = logsDir(worktree.path)
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, `agent-${name}.log`)
    await writeFile(logPath, '', 'utf8').catch(() => {})
    const logStream = createWriteStream(logPath, { flags: 'a' })

    const child = spawn(command, {
      cwd: worktree.path,
      env: spawnEnv(vars),
      shell: true
    })

    const runtime: AgentRuntime = {
      worktreeId: worktree.id,
      name,
      status: 'running',
      pid: child.pid ?? null,
      command,
      exitCode: null,
      logPath
    }

    const entry: RunningAgent = { child, logStream, runtime }
    this.running.set(this.key(worktree.id, name), entry)

    const handle = (buffer: Buffer): void => {
      const text = buffer.toString()
      entry.logStream.write(text)
      text
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => this.events.onLog(worktree.id, name, line))
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)

    child.on('exit', (code) => this.handleExit(worktree.id, name, code))
    child.on('error', (err) => {
      this.events.onLog(worktree.id, name, `[agent] spawn error: ${err.message}`)
      const active = this.running.get(this.key(worktree.id, name))
      if (active) active.runtime.status = 'error'
      this.handleExit(worktree.id, name, 1)
    })

    this.events.onStatus({ ...runtime })
    return { ...runtime }
  }

  private handleExit(worktreeId: string, name: string, code: number | null): void {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    entry.logStream.end()
    entry.runtime.exitCode = code
    if (entry.runtime.status !== 'error') {
      entry.runtime.status = code === 0 ? 'exited' : 'error'
    }
    entry.runtime.pid = null
    this.events.onStatus({ ...entry.runtime })
    this.running.delete(this.key(worktreeId, name))
  }

  async stop(worktreeId: string, name: string): Promise<void> {
    const entry = this.running.get(this.key(worktreeId, name))
    if (!entry) return
    const pid = entry.child.pid
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already dead
      }
    }
  }

  // Which worktrees currently have at least one running agent.
  activeWorktreeIds(): string[] {
    const ids = new Set<string>()
    for (const key of this.running.keys()) {
      ids.add(key.split('::')[0])
    }
    return [...ids]
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.running.keys()]) {
      const [worktreeId, name] = key.split('::')
      await this.stop(worktreeId, name)
    }
  }
}

// Minimal POSIX single-quote escaping for passing a prompt as one argument.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
