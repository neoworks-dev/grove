// Reads a process-compose file into the subset this plugin runs: each
// process's command, working directory, environment and dependencies. Unknown
// keys are ignored rather than rejected, so a file written for the full
// process-compose keeps loading here.

import { load } from 'js-yaml'

// Open string: 'process_started', 'process_completed', … — new conditions
// upstream must not break parsing; the runner treats unknown ones as started.
export type DependencyCondition = string

export interface ProcessSpec {
  name: string
  command: string
  // Relative to the worktree root.
  workingDir: string
  environment: Record<string, string>
  dependsOn: { name: string; condition: DependencyCondition }[]
  disabled: boolean
}

export interface ComposeConfig {
  // Worktree-relative path of the file this came from.
  file: string
  processes: ProcessSpec[]
}

export const CONFIG_NAMES = [
  'process-compose.yaml',
  'process-compose.yml',
  '.process-compose.yaml',
  '.process-compose.yml'
]

export function isConfigFile(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return CONFIG_NAMES.includes(base)
}

export function parseConfig(file: string, text: string): ComposeConfig {
  const root = load(text)
  if (!isRecord(root)) throw new Error(`${file}: expected a mapping at the top level`)
  const processes = root.processes
  if (!isRecord(processes)) throw new Error(`${file}: no "processes" section`)

  const configDir = dirname(file)
  const globalEnv = parseEnvironment(root.environment)
  const specs: ProcessSpec[] = []
  for (const [name, raw] of Object.entries(processes)) {
    if (!isRecord(raw)) continue
    const command = typeof raw.command === 'string' ? raw.command : ''
    const workingDir = typeof raw.working_dir === 'string' ? raw.working_dir : '.'
    specs.push({
      name,
      command,
      workingDir: resolveDir(configDir, workingDir),
      environment: { ...globalEnv, ...parseEnvironment(raw.environment) },
      dependsOn: parseDependencies(raw.depends_on),
      disabled: raw.disabled === true
    })
  }
  return { file, processes: specs }
}

// process-compose writes environment as a list of "KEY=value"; a mapping is
// accepted as well since YAML users reach for it.
function parseEnvironment(value: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const eq = entry.indexOf('=')
      if (eq <= 0) continue
      env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue
      env[key] = String(entry)
    }
  }
  return env
}

function parseDependencies(value: unknown): ProcessSpec['dependsOn'] {
  if (!isRecord(value)) return []
  return Object.entries(value).map(([name, raw]) => {
    const condition =
      isRecord(raw) && typeof raw.condition === 'string' ? raw.condition : 'process_started'
    return { name, condition }
  })
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}

function resolveDir(base: string, dir: string): string {
  if (dir.startsWith('/')) return dir
  if (base === '.') return dir
  if (dir === '.' || dir === './') return base
  return `${base}/${dir}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
