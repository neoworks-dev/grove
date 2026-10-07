// The page's state: the project as the worker last described it, the process
// picked in the list, and each process's output for the terminals to draw.
// The worker is the source of truth; this only mirrors what it sends.

import { connectPane, type PaneConnection } from '@grove/plugin-sdk/pane'
import type { ProcessView, ProjectView, ToPage, ToWorker } from '../messages'

// Raw output kept per process, so a terminal mounted later starts complete.
const MAX_BACKLOG_CHARS = 512 * 1024

export interface OutputEvent {
  // True when the output started over (a new run); `data` is then all of it.
  reset: boolean
  data: string
}

type OutputListener = (event: OutputEvent) => void

class ProjectState {
  project = $state<ProjectView | null>(null)
  selected = $state<string | null>(null)
  // Bumped whenever Grove's theme changes, for what reads tokens directly.
  themeVersion = $state(0)

  private readonly backlogs = new Map<string, string>()
  private readonly listeners = new Map<string, Set<OutputListener>>()
  private connection: PaneConnection | null = null

  /** Connects to the worker; called once the page is up. */
  connect(): void {
    this.connection = connectPane({
      onMessage: (data) => this.receive(data as ToPage),
      onTheme: () => {
        this.themeVersion += 1
      }
    })
  }

  /** Tells the worker what the user did. */
  send(message: ToWorker): void {
    this.connection?.post(message)
  }

  /** The selected process, or null. */
  get selectedProcess(): ProcessView | null {
    const processes = this.project?.processes ?? []
    return processes.find((process) => process.name === this.selected) ?? null
  }

  select(name: string): void {
    this.selected = name
  }

  /** Moves the selection up or down the list. */
  step(offset: number): void {
    const processes = this.project?.processes ?? []
    if (processes.length === 0) return
    const index = processes.findIndex((process) => process.name === this.selected)
    const next = Math.min(processes.length - 1, Math.max(0, index + offset))
    this.selected = processes[next].name
  }

  /**
   * Calls `listener` with a process's output: everything so far straight away,
   * then each new chunk. Returns the inverse.
   */
  watchOutput(name: string, listener: OutputListener): () => void {
    let listeners = this.listeners.get(name)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(name, listeners)
    }
    listeners.add(listener)
    listener({ reset: true, data: this.backlogs.get(name) ?? '' })
    return () => listeners.delete(listener)
  }

  private receive(message: ToPage): void {
    if (message.type === 'state') {
      this.applyState(message.project)
      return
    }
    this.appendOutput(message.name, message.data, message.type === 'output-reset')
  }

  private applyState(project: ProjectView): void {
    this.project = project
    const names = new Set(project.processes.map((process) => process.name))
    for (const name of [...this.backlogs.keys()]) {
      if (!names.has(name)) this.backlogs.delete(name)
    }
    if (this.selected && names.has(this.selected)) return
    const running = project.processes.find((process) => process.status === 'running')
    const first = running ?? project.processes[0]
    this.selected = first ? first.name : null
  }

  private appendOutput(name: string, data: string, reset: boolean): void {
    let backlog = reset ? data : (this.backlogs.get(name) ?? '') + data
    if (backlog.length > MAX_BACKLOG_CHARS) backlog = backlog.slice(backlog.length - MAX_BACKLOG_CHARS)
    this.backlogs.set(name, backlog)
    for (const listener of this.listeners.get(name) ?? []) listener({ reset, data })
  }
}

export const projectState = new ProjectState()
