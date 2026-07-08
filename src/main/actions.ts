// One-shot shell commands triggered by keybind actions. Unlike the service
// supervisor (which manages long-lived, health-checked processes), these are
// fire-and-forget: spawn in the worktree with the same env substitutions as
// services, stream output to the logs pane, and forget on exit.

import { spawn, type ChildProcess } from 'child_process'
import type { Worktree } from '../shared/types'
import { buildWorktreeEnv, substitute, spawnEnv } from './env'

interface RunnerEvents {
  onLog: (worktreeId: string, line: string) => void
}

export class ActionRunner {
  private events: RunnerEvents
  private children = new Set<ChildProcess>()

  constructor(events: RunnerEvents) {
    this.events = events
  }

  run(worktree: Worktree, commandLine: string, ports: number[]): void {
    const vars = buildWorktreeEnv(worktree, ports)
    const command = substitute(commandLine, vars)
    const child = spawn(command, {
      cwd: worktree.path,
      env: spawnEnv(vars),
      shell: true,
      detached: false
    })
    this.children.add(child)
    this.events.onLog(worktree.id, `$ ${command}`)
    this.pipe(worktree.id, child)
    child.on('exit', (code) => {
      this.children.delete(child)
      if (code !== 0) this.events.onLog(worktree.id, `command exited with code ${code}`)
    })
  }

  private pipe(worktreeId: string, child: ChildProcess): void {
    const emit = (chunk: Buffer): void => {
      const lines = chunk.toString('utf8').split('\n')
      for (const line of lines) {
        if (line.trim().length > 0) this.events.onLog(worktreeId, line)
      }
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
  }

  stopAll(): void {
    for (const child of this.children) child.kill()
    this.children.clear()
  }
}
