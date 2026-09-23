// Detects long-running services from package.json scripts.
//
// Most scripts are one-shot (build, lint, test) and would be wrong to supervise
// as a service. There is no machine-readable marker for "this one is a server",
// so the detector matches indicator words in the script name and body. That is a
// heuristic and it will occasionally over-propose — acceptable, because the user
// reviews every proposal before it is written.

import type { DetectorFiles, ProjectDetector, ServiceProposal } from './types'
import { forcePort, localhostUrl, rewritePort } from './ports'
import { LOCKFILE_MANAGERS, managerForLockfiles } from './packageManagers'

const PACKAGE_JSON = 'package.json'

// Words that suggest a script stays in the foreground serving something.
// Exported so this stays the single place to tune the heuristic.
export const SERVICE_INDICATORS = ['dev', 'serve', 'start', 'watch', 'preview']

export function parsePackageScripts(files: DetectorFiles): ServiceProposal[] {
  const manifest = files[PACKAGE_JSON]
  if (!manifest) return []

  const scripts = readScripts(manifest)
  if (!scripts) return []

  const runner = pickRunner(files)
  const proposals: ServiceProposal[] = []

  for (const [scriptName, scriptBody] of Object.entries(scripts)) {
    if (!looksLikeService(scriptName, scriptBody)) continue
    proposals.push(buildProposal(scriptName, scriptBody, runner))
  }

  return proposals
}

function readScripts(manifest: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    // A package.json we cannot parse is not something to guess about — the user
    // has a broken manifest and detection is not the place to report it.
    return null
  }

  const scripts = (parsed as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object') return null

  const result: Record<string, string> = {}
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body === 'string') result[name] = body
  }
  return result
}

/** The run prefix the project's lockfile implies, npm's when it has none. */
function pickRunner(files: DetectorFiles): string {
  const manager = managerForLockfiles(Object.keys(files))
  if (!manager) return 'npm run'
  return `${manager} run`
}

function looksLikeService(scriptName: string, scriptBody: string): boolean {
  const haystack = `${scriptName} ${scriptBody}`.toLowerCase()
  return SERVICE_INDICATORS.some((indicator) => haystack.includes(indicator))
}

function buildProposal(scriptName: string, scriptBody: string, runner: string): ServiceProposal {
  // The script body tells us how this project names its port, but the proposal
  // invokes the script rather than inlining it — rewriting package.json is not
  // our job. So the port is forced from the outside, in whichever form beats
  // what the script already sets. `--` passes the flag through the package
  // runner to the underlying command.
  const rewrite = rewritePort(scriptBody)

  return {
    name: scriptName,
    command: forcePort(`${runner} ${scriptName}`, rewrite.style, true),
    preview: localhostUrl(),
    health: localhostUrl(),
    source: packageScriptsDetector.id,
    usesPort: true
  }
}

export const packageScriptsDetector: ProjectDetector = {
  id: 'package-scripts',
  title: 'package.json scripts',
  files: [PACKAGE_JSON, ...LOCKFILE_MANAGERS.map((candidate) => candidate.file)],
  detect: parsePackageScripts
}
