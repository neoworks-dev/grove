// The page's state: the project as the worker last described it, the process
// picked in the list, the list's filter, the pane's layout preferences, and
// each process's output for the terminals to draw. The worker is the source
// of truth for everything but the selection and the filter.

import { connectPane, type PaneConnection } from '@grove/plugin-sdk/pane'
import type { PanePrefs, ProcessView, ProjectView, ToPage, ToWorker } from '../messages'
import { isLive } from './status'
import { lastLine } from '../plainText'

// How much of the end of a process's output is searched for its last line.
const LAST_LINE_WINDOW_CHARS = 4096

// How often running processes' uptimes are brought up to date.
const CLOCK_TICK_MS = 1000

// Raw output kept per process, so a terminal mounted later starts complete.
const MAX_BACKLOG_CHARS = 512 * 1024

export interface OutputEvent {
  // True when the output started over (a new run); `data` is then all of it.
  reset: boolean
  data: string
}

type OutputListener = (event: OutputEvent) => void

// A row in the process list: a process, or the Disabled group's header.
export type ListRow = { kind: 'process'; name: string } | { kind: 'group' }

class ProjectState {
  project = $state<ProjectView | null>(null)
  selected = $state<string | null>(null)
  // Whether the collapsed group of disabled processes is open.
  showDisabled = $state(false)
  // The keyboard cursor rests on the Disabled group's header rather than a
  // process; the detail panel keeps showing the last selected process.
  groupSelected = $state(false)
  // Narrows the list to processes whose name contains it, ignoring case.
  filter = $state('')
  // Bumped to ask the filter box to take focus.
  filterFocusRequests = $state(0)
  // Whether the output search bar is open; bumped to ask it to take focus.
  searchOpen = $state(false)
  searchFocusRequests = $state(0)
  // The pane's layout, as the worker stored it.
  prefs = $state<PanePrefs>({ listWidth: null, wrap: false })
  // The time uptimes are measured against; ticks only while something runs.
  now = $state(Date.now())
  // Bumped whenever Grove's theme changes, for what reads tokens directly.
  themeVersion = $state(0)
  // Each process's last line of output, as plain text: why a failed one failed.
  lastLines = $state<Record<string, string>>({})

  private readonly backlogs = new Map<string, string>()
  private readonly listeners = new Map<string, Set<OutputListener>>()
  private connection: PaneConnection | null = null
  private clock: ReturnType<typeof setInterval> | null = null

  /** Connects to the worker; called once the page is up. */
  connect(): void {
    this.connection = connectPane({
      onMessage: (data) => this.receive(data as ToPage),
      onTheme: () => {
        this.themeVersion += 1
      }
    })
  }

  /** Puts the cursor in the list's filter box. */
  focusFilter(): void {
    this.filterFocusRequests += 1
  }

  /** Opens the output search, or refocuses it when open. */
  openSearch(): void {
    this.searchOpen = true
    this.searchFocusRequests += 1
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
    this.groupSelected = false
  }

  /** Puts the cursor on the Disabled group's header. */
  selectGroup(): void {
    this.groupSelected = true
  }

  /** Opens or closes the Disabled group; closing it while inside moves the cursor to its header. */
  setDisabledOpen(open: boolean): void {
    this.showDisabled = open
    if (open) return
    if (this.selectedProcess?.disabled) this.groupSelected = true
  }

  /** Whether the Disabled group's rows show: opened, or a filter is narrowing the list. */
  get disabledOpen(): boolean {
    return this.showDisabled || this.filter !== ''
  }

  /** The processes that can run and match the filter, failed ones first, else in file order. */
  get enabledProcesses(): ProcessView[] {
    const processes = this.matching().filter((process) => !process.disabled)
    const failed = processes.filter((process) => process.status === 'failed')
    const rest = processes.filter((process) => process.status !== 'failed')
    return [...failed, ...rest]
  }

  /** The processes the file disables that match the filter, listed apart at the bottom. */
  get disabledProcesses(): ProcessView[] {
    return this.matching().filter((process) => process.disabled)
  }

  /** Every process whose name matches the filter. */
  private matching(): ProcessView[] {
    const processes = this.project?.processes ?? []
    const needle = this.filter.trim().toLowerCase()
    if (!needle) return processes
    return processes.filter((process) => process.name.toLowerCase().includes(needle))
  }

  /** The rows the list shows, top to bottom: what the keyboard cursor walks. */
  get rows(): ListRow[] {
    const rows: ListRow[] = this.enabledProcesses.map((process) => ({ kind: 'process', name: process.name }))
    if (this.disabledProcesses.length === 0) return rows
    rows.push({ kind: 'group' })
    if (!this.disabledOpen) return rows
    for (const process of this.disabledProcesses) rows.push({ kind: 'process', name: process.name })
    return rows
  }

  /** Selects the next failed process after the cursor, wrapping round; false when none failed. */
  selectNextFailed(): boolean {
    const failed = (this.project?.processes ?? []).filter((process) => process.status === 'failed')
    if (failed.length === 0) return false
    const index = failed.findIndex((process) => process.name === this.selected)
    const next = failed[(index + 1) % failed.length]
    if (next.disabled) this.showDisabled = true
    this.filter = ''
    this.select(next.name)
    return true
  }

  /** Changes the pane's layout here straight away, and has the worker keep it. */
  setPrefs(change: Partial<PanePrefs>): void {
    this.prefs = { ...this.prefs, ...change }
    this.send({ type: 'set-prefs', prefs: change })
  }

  /** Drops a process's output so far, here and in the worker. */
  clearOutput(name: string): void {
    this.send({ type: 'clear-output', name })
  }

  /** Has the worker copy a process's output to the clipboard. */
  copyOutput(name: string): void {
    this.send({ type: 'copy-output', name })
  }

  /** Moves the cursor up or down the visible rows, stopping at either end. */
  step(offset: number): void {
    const rows = this.rows
    if (rows.length === 0) return
    const index = rows.findIndex((row) => this.isCursor(row))
    this.moveTo(rows, Math.min(rows.length - 1, Math.max(0, index + offset)))
  }

  /** Moves the cursor to the first or last visible row. */
  jumpTo(end: 'first' | 'last'): void {
    const rows = this.rows
    if (rows.length === 0) return
    if (end === 'first') {
      this.moveTo(rows, 0)
    } else {
      this.moveTo(rows, rows.length - 1)
    }
  }

  /** Whether the cursor is on `row`. */
  private isCursor(row: ListRow): boolean {
    if (row.kind === 'group') return this.groupSelected
    return !this.groupSelected && row.name === this.selected
  }

  private moveTo(rows: ListRow[], index: number): void {
    const row = rows[index]
    if (row.kind === 'group') {
      this.selectGroup()
    } else {
      this.select(row.name)
    }
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
    if (message.type === 'prefs') {
      this.prefs = message.prefs
      return
    }
    this.appendOutput(message.name, message.data, message.type === 'output-reset')
  }

  /** Ticks the clock while any process runs, so uptimes advance, and stops it otherwise. */
  private syncClock(project: ProjectView): void {
    const running = project.processes.some((process) => isLive(process.status))
    if (running && !this.clock) {
      this.now = Date.now()
      this.clock = setInterval(() => {
        this.now = Date.now()
      }, CLOCK_TICK_MS)
    }
    if (!running && this.clock) {
      clearInterval(this.clock)
      this.clock = null
    }
  }

  private applyState(project: ProjectView): void {
    this.project = project
    this.syncClock(project)
    const names = new Set(project.processes.map((process) => process.name))
    for (const name of [...this.backlogs.keys()]) {
      if (!names.has(name)) this.backlogs.delete(name)
    }
    if (this.selected && names.has(this.selected)) return
    const running = project.processes.find((process) => process.status === 'running')
    const first = running ?? this.enabledProcesses[0] ?? project.processes[0]
    this.selected = first ? first.name : null
  }

  private appendOutput(name: string, data: string, reset: boolean): void {
    let backlog = reset ? data : (this.backlogs.get(name) ?? '') + data
    if (backlog.length > MAX_BACKLOG_CHARS) backlog = backlog.slice(backlog.length - MAX_BACKLOG_CHARS)
    this.backlogs.set(name, backlog)
    this.lastLines[name] = lastLine(backlog.slice(-LAST_LINE_WINDOW_CHARS))
    for (const listener of this.listeners.get(name) ?? []) listener({ reset, data })
  }
}

export const projectState = new ProjectState()
