// The pane's keys, live whenever the pane has focus and a process's terminal
// isn't taking typing. Lower case acts on the selected process, upper case on
// the whole project. Keys handled here are marked handled, so the SDK doesn't
// pass them up to Grove; everything else still reaches Grove's bindings.

import { projectState } from './project.svelte'
import { isLive } from './status'

// What each key does, for the hints shown in tooltips.
export const KEY_HINTS = {
  start: 's',
  stop: 'x',
  restart: 'r',
  startAll: 'S',
  stopAll: 'X',
  restartAll: 'R',
  openFile: 'o',
  nextFailed: 'f',
  filter: '/',
  wrap: 'w',
  clearOutput: 'c',
  copyOutput: 'y',
  search: 'Ctrl+F'
} as const

// Keys that move the cursor, by how far.
const STEPS: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }

/** Handles a key for the pane; says whether it was one of the pane's. */
export function handlePaneKey(event: KeyboardEvent): boolean {
  // Searching the output works from inside the terminal too, so it comes first.
  if (isSearchChord(event)) {
    projectState.openSearch()
    return true
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  if (isTextEntry(event.target)) return false
  if (moveCursor(event.key)) return true
  if (actOnView(event.key)) return true
  if (projectState.groupSelected) return actOnGroup(event.key)
  if (actOnSelected(event.key)) return true
  return actOnProject(event.key)
}

/** Ctrl+F (Cmd+F on macOS). */
function isSearchChord(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === 'f' || event.key === 'F'
}

/** / filters the list, f jumps to the next failure, w toggles wrapping. */
function actOnView(key: string): boolean {
  if (key === KEY_HINTS.filter) {
    projectState.focusFilter()
    return true
  }
  if (key === KEY_HINTS.nextFailed) return projectState.selectNextFailed()
  if (key === KEY_HINTS.wrap) {
    projectState.setPrefs({ wrap: !projectState.prefs.wrap })
    return true
  }
  return actOnOutput(key)
}

/** c clears the selected process's output, y copies it. */
function actOnOutput(key: string): boolean {
  const process = projectState.selectedProcess
  if (!process || projectState.groupSelected) return false
  if (key === KEY_HINTS.clearOutput) {
    projectState.clearOutput(process.name)
    return true
  }
  if (key === KEY_HINTS.copyOutput) {
    projectState.copyOutput(process.name)
    return true
  }
  return false
}

/** j/k and the arrows step, g/G and Home/End jump to either end. */
function moveCursor(key: string): boolean {
  if (key in STEPS) {
    projectState.step(STEPS[key])
    return true
  }
  if (key === 'g' || key === 'Home') {
    projectState.jumpTo('first')
    return true
  }
  if (key === 'G' || key === 'End') {
    projectState.jumpTo('last')
    return true
  }
  return false
}

/** On the Disabled header: Enter/Space toggle it, l/Right open it, h/Left close it. */
function actOnGroup(key: string): boolean {
  if (key === 'Enter' || key === ' ') {
    projectState.setDisabledOpen(!projectState.showDisabled)
    return true
  }
  if (key === 'l' || key === 'ArrowRight') {
    projectState.setDisabledOpen(true)
    return true
  }
  if (key === 'h' || key === 'ArrowLeft') {
    projectState.setDisabledOpen(false)
    return true
  }
  return actOnProject(key)
}

/** On a process: Enter/Space toggle it, s starts, x stops, r restarts; h/Left inside the Disabled group closes it. */
function actOnSelected(key: string): boolean {
  const process = projectState.selectedProcess
  if (!process) return false
  const live = isLive(process.status)
  if (key === 'Enter' || key === ' ') {
    projectState.send({ type: live ? 'stop' : 'start', name: process.name })
    return true
  }
  if (key === KEY_HINTS.start && !live) {
    projectState.send({ type: 'start', name: process.name })
    return true
  }
  if (key === KEY_HINTS.stop && live) {
    projectState.send({ type: 'stop', name: process.name })
    return true
  }
  if (key === KEY_HINTS.restart) {
    projectState.send({ type: live ? 'restart' : 'start', name: process.name })
    return true
  }
  if ((key === 'h' || key === 'ArrowLeft') && process.disabled) {
    projectState.setDisabledOpen(false)
    return true
  }
  return false
}

/** S, X and R start, stop and restart everything; o opens the config file. */
function actOnProject(key: string): boolean {
  if (key === KEY_HINTS.startAll) {
    projectState.send({ type: 'start' })
    return true
  }
  if (key === KEY_HINTS.stopAll) {
    projectState.send({ type: 'stop' })
    return true
  }
  if (key === KEY_HINTS.restartAll) {
    projectState.send({ type: 'restart' })
    return true
  }
  if (key === KEY_HINTS.openFile) {
    projectState.send({ type: 'open-file' })
    return true
  }
  return false
}

/** Whether keys aimed at `target` are text being typed, such as into a process's terminal. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}
