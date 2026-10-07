// Process Compose: runs the worktree's process-compose file without the
// process-compose binary. This worker parses the file, runs each process in
// its own plugin-owned terminal and keeps their output; the pane page
// (src/pages/main.ts) draws all of it and sends back what the user does.
// One project per worktree, each independent; the pane shows the selected one.

import * as grove from '@grove/plugin-sdk'
import { isConfigFile, parseConfig, type ComposeConfig } from './config'
import type { ProjectView, ToPage, ToWorker } from './messages'
import { ProjectRunner } from './runner'
import { cancellation } from './token'

const PANE_ID = 'processCompose'
const VIEW_ID = 'processCompose'
// Output and status are batched per animation-ish tick on their way out.
const FLUSH_MS = 30

interface WorktreeState {
  // Every process-compose file in the worktree; null until looked up.
  files: string[] | null
  file: string | null
  config: ComposeConfig | null
  error: string | null
  runner: ProjectRunner | null
}

const states = new Map<string, WorktreeState>()
let current: grove.WorktreeInfo | null = null

export function activate(context: grove.PluginContext): void {
  const outbox = new Outbox()

  context.subscriptions.push(
    grove.panes.registerPage(PANE_ID, {
      onOpen: ({ instanceId }) => void sendEverything(instanceId),
      onMessage: (data) => handle(data as ToWorker)
    }),
    grove.events.on('workspace.didChangeWorktree', () => void sendEverything()),
    grove.commands.register('processCompose.up', () => withCurrent(startAll)),
    grove.commands.register('processCompose.down', () =>
      withCurrent((_, state) => state.runner?.stopAll())
    ),
    grove.commands.register('processCompose.restart', () =>
      withCurrent((id, state) => restartAll(id, state))
    ),
    grove.commands.register('processCompose.open', () => grove.commands.execute(`view.${VIEW_ID}`)),
    grove.commands.register('processCompose.openFile', () => withCurrent(openFile))
  )
  watchConfigFiles(context, () => void sendEverything())

  /** The selected worktree and its state, loaded. */
  async function resolveCurrent(): Promise<{ id: string; state: WorktreeState } | null> {
    current = await grove.workspace.getCurrentWorktree()
    if (!current) return null
    let state = states.get(current.id)
    if (!state) {
      state = { files: null, file: null, config: null, error: null, runner: null }
      states.set(current.id, state)
    }
    await load(current.id, state)
    return { id: current.id, state }
  }

  async function withCurrent(
    action: (worktreeId: string, state: WorktreeState) => unknown
  ): Promise<void> {
    const target = await resolveCurrent()
    if (target) await action(target.id, target.state)
    outbox.state(view(target?.state ?? null))
  }

  /** A runner built from the file as it is now, unless one is still running. */
  function runnerFor(worktreeId: string, state: WorktreeState): ProjectRunner | null {
    if (state.runner?.active) return state.runner
    if (!state.config) return null
    state.runner = new ProjectRunner(worktreeId, state.config.file, state.config.processes, {
      onChange: () => {
        if (worktreeId === current?.id) outbox.state(view(state))
      },
      onOutput: (name, data) => {
        if (worktreeId === current?.id) outbox.output(name, data)
      },
      onOutputReset: (name) => {
        if (worktreeId === current?.id) outbox.reset(name, '')
      }
    })
    return state.runner
  }

  function startAll(worktreeId: string, state: WorktreeState): void {
    const runner = runnerFor(worktreeId, state)
    if (!runner) {
      grove.ui.notify({ level: 'warn', message: state.error ?? 'No process-compose file found.' })
      return
    }
    runner.startAll()
  }

  async function restartAll(worktreeId: string, state: WorktreeState): Promise<void> {
    await state.runner?.stopAll()
    startAll(worktreeId, state)
  }

  async function openFile(_: string, state: WorktreeState): Promise<void> {
    if (state.file) await grove.workspace.openFile(state.file)
  }

  async function handle(message: ToWorker): Promise<void> {
    const target = await resolveCurrent()
    if (!target) return
    const { id, state } = target
    switch (message.type) {
      case 'start':
        if (message.name) runnerFor(id, state)?.start(message.name)
        else startAll(id, state)
        break
      case 'stop':
        if (message.name) await state.runner?.stop(message.name)
        else await state.runner?.stopAll()
        break
      case 'restart':
        if (message.name) await runnerFor(id, state)?.restart(message.name)
        else await restartAll(id, state)
        break
      case 'select-file':
        selectFile(state, message.file)
        await load(id, state)
        await sendEverything()
        return
      case 'open-file':
        await openFile(id, state)
        return
      case 'input':
        state.runner?.write(message.name, message.data)
        return
      case 'resize':
        state.runner?.resize(message.name, message.cols, message.rows)
        return
    }
    outbox.state(view(state))
  }

  /** The state and every process's output so far, to one page or all of them. */
  async function sendEverything(instanceId?: string): Promise<void> {
    const target = await resolveCurrent()
    const state = target?.state ?? null
    outbox.state(view(state), instanceId)
    for (const process of state?.runner?.processes.values() ?? []) {
      outbox.reset(process.spec.name, process.output.value, instanceId)
    }
  }
}

export async function deactivate(): Promise<void> {
  await Promise.all([...states.values()].map((state) => state.runner?.stopAll()))
}

async function load(worktreeId: string, state: WorktreeState): Promise<void> {
  if (state.files === null) {
    const all = await grove.workspace.findFiles({ worktreeId }).catch(() => [] as string[])
    const files = all.filter(isConfigFile).sort(byDepthThenName)
    state.files = files
    if (!state.file || !files.includes(state.file)) state.file = files[0] ?? null
    state.config = null
  }
  if (state.config || !state.file) return
  try {
    const text = await grove.workspace.readFile(state.file, { worktreeId })
    state.config = parseConfig(state.file, text)
    state.error = null
  } catch (error) {
    state.config = null
    state.error = error instanceof Error ? error.message : String(error)
  }
}

function selectFile(state: WorktreeState, file: string): void {
  if (file === state.file || !state.files?.includes(file)) return
  if (state.runner?.active) {
    grove.ui.notify({ level: 'warn', message: 'Stop the running processes first.' })
    return
  }
  state.file = file
  state.config = null
  state.runner = null
}

/** What the page draws: the runner's processes once started, else the file's. */
function view(state: WorktreeState | null): ProjectView {
  const runner = state?.runner
  const specs = state?.config?.processes ?? []
  const processes = runner
    ? [...runner.processes.values()].map((process) => ({
        spec: process.spec,
        status: process.status,
        exitCode: process.exitCode
      }))
    : specs.map((spec) => ({
        spec,
        status: spec.disabled ? ('disabled' as const) : ('idle' as const),
        exitCode: null
      }))
  return {
    branch: current?.branch ?? null,
    files: state?.files ?? [],
    file: state?.file ?? null,
    error: state?.error ?? null,
    processes: processes.map(({ spec, status, exitCode }) => ({
      name: spec.name,
      command: spec.command,
      workingDir: spec.workingDir,
      dependsOn: spec.dependsOn,
      status,
      exitCode
    }))
  }
}

/**
 * Batches what goes to the pages: the latest state wins, output is appended,
 * and a reset drops whatever output for that process was still waiting.
 */
class Outbox {
  private pendingState: ProjectView | null = null
  private pendingOutput = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  state(project: ProjectView, instanceId?: string): void {
    if (instanceId) {
      this.send({ type: 'state', project }, instanceId)
      return
    }
    this.pendingState = project
    this.schedule()
  }

  output(name: string, data: string): void {
    this.pendingOutput.set(name, (this.pendingOutput.get(name) ?? '') + data)
    this.schedule()
  }

  reset(name: string, data: string, instanceId?: string): void {
    if (!instanceId) {
      this.flush()
      this.pendingOutput.delete(name)
    }
    this.send({ type: 'output-reset', name, data }, instanceId)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pendingState) this.send({ type: 'state', project: this.pendingState })
    this.pendingState = null
    for (const [name, data] of this.pendingOutput) this.send({ type: 'output', name, data })
    this.pendingOutput.clear()
  }

  private send(message: ToPage, instanceId?: string): void {
    grove.panes.postMessage(PANE_ID, message, instanceId ? { instanceId } : undefined)
  }
}

// Edits to a config file show up straight away; a running project keeps what
// it started with until it is started again.
function watchConfigFiles(context: grove.PluginContext, onChange: () => void): void {
  const { token, cancel } = cancellation()
  context.subscriptions.push({ dispose: cancel })
  void (async () => {
    for await (const event of grove.events.subscribe(['files.didChange'], token)) {
      const change = event.payload as { relPath?: string; path?: string } | null
      if (!isConfigFile(change?.relPath ?? change?.path ?? '')) continue
      for (const state of states.values()) {
        state.files = null
        state.config = null
      }
      onChange()
    }
  })().catch(() => undefined)
}

function byDepthThenName(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  return depth !== 0 ? depth : a.localeCompare(b)
}
