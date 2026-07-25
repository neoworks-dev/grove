// Renders a WorkbenchConfig as annotated YAML.
//
// `saveConfig` uses js-yaml's `dump`, which strips every comment and reorders
// keys — a config written that way is worse than the commented sample it would
// replace, and workbench.yaml is a file the user is expected to keep editing by
// hand. So the wizard renders its own text: fixed section order, the same
// explanatory comments the sample carries, and values quoted only where YAML
// requires it.

import type { ServiceConfig, WorkbenchConfig } from '../shared/types'

// `${PORT_0}` and friends are safe unquoted in YAML, but a value starting with a
// character YAML gives meaning to is not. Quote conservatively.
const NEEDS_QUOTING = /^[\s]|[:#]\s|^[-?[\]{}&*!|>'"%@`]|[\s]$/

export function renderConfig(config: WorkbenchConfig): string {
  const sections = [
    renderWorkbench(config),
    renderPorts(config),
    renderSetup(config),
    renderServices(config),
    renderAgents(config)
  ]

  return `${sections.join('\n')}\n`
}

function renderWorkbench(config: WorkbenchConfig): string {
  return [
    'workbench:',
    `  worktrees_dir: ${scalar(config.workbench.worktrees_dir)}`,
    `  default_base_branch: ${scalar(config.workbench.default_base_branch)}`,
    ''
  ].join('\n')
}

function renderPorts(config: WorkbenchConfig): string {
  return [
    '# Each worktree gets a contiguous block of ports starting at',
    '# `start + slot * count_per_worktree`, exposed to commands as ${PORT_0}, ${PORT_1}, …',
    'ports:',
    `  start: ${config.ports.start}`,
    `  count_per_worktree: ${config.ports.count_per_worktree}`,
    ''
  ].join('\n')
}

function renderSetup(config: WorkbenchConfig): string {
  return [
    '# `once` runs the first time this repo is opened; `per_worktree` runs when a',
    '# worktree is created.',
    'setup:',
    ...renderCommandList('once', config.setup.once),
    ...renderCommandList('per_worktree', config.setup.per_worktree),
    ''
  ].join('\n')
}

function renderCommandList(key: string, commands: string[]): string[] {
  if (commands.length === 0) return [`  ${key}: []`]
  return [`  ${key}:`, ...commands.map((command) => `    - ${scalar(command)}`)]
}

function renderServices(config: WorkbenchConfig): string {
  const names = Object.keys(config.services)
  if (names.length === 0) {
    return ['# Long-running processes Grove supervises per worktree.', 'services: {}', ''].join(
      '\n'
    )
  }

  const lines = ['# Long-running processes Grove supervises per worktree.', 'services:']
  for (const name of names) {
    lines.push(...renderService(name, config.services[name]))
  }
  lines.push('')
  return lines.join('\n')
}

function renderService(name: string, service: ServiceConfig): string[] {
  const lines = [`  ${name}:`, `    command: ${scalar(service.command)}`]

  // Optional fields are omitted rather than written empty, so a hand-edited file
  // and a wizard-written one look the same.
  if (service.preview) lines.push(`    preview: ${scalar(service.preview)}`)
  if (service.health) lines.push(`    health: ${scalar(service.health)}`)
  if (service.log) lines.push(`    log: ${scalar(service.log)}`)

  return lines
}

function renderAgents(config: WorkbenchConfig): string {
  const names = Object.keys(config.agents)
  const header = [
    '# Grove bundles adapters for claude, codex and opencode. List entries here',
    '# only to override an adapter command or add an unknown CLI.'
  ]

  if (names.length === 0) return [...header, 'agents: {}'].join('\n')

  const lines = [...header, 'agents:']
  for (const name of names) {
    lines.push(`  ${name}:`, `    command: ${scalar(config.agents[name].command)}`)
  }
  return lines.join('\n')
}

function scalar(value: string): string {
  if (value === '') return "''"
  if (NEEDS_QUOTING.test(value)) return `'${value.replace(/'/g, "''")}'`
  return value
}
