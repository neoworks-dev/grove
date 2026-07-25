// Detects services from a Procfile.
//
// A Procfile is the one input here that is already an explicit list of
// long-running processes, so every entry becomes a proposal — no heuristic
// needed, unlike package.json scripts.

import type { DetectorFiles, ProjectDetector, ServiceProposal } from './types'
import { forcePort, localhostUrl, rewritePort } from './ports'

const PROCFILE = 'Procfile'

// `name: command`, where the name is a process type.
const ENTRY_PATTERN = /^([A-Za-z0-9_-]+):\s*(.+)$/

export function parseProcfile(files: DetectorFiles): ServiceProposal[] {
  const contents = files[PROCFILE]
  if (!contents) return []

  const proposals: ServiceProposal[] = []

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue

    const match = line.match(ENTRY_PATTERN)
    if (!match) continue

    proposals.push(buildProposal(match[1], match[2].trim()))
  }

  return proposals
}

function buildProposal(name: string, command: string): ServiceProposal {
  return {
    name,
    command: portedCommand(command),
    preview: localhostUrl(),
    health: localhostUrl(),
    source: procfileDetector.id,
    usesPort: true
  }
}

function portedCommand(command: string): string {
  // Procfile commands are run directly, so a port already in the command can be
  // substituted in place rather than overridden from outside.
  const rewrite = rewritePort(command)
  if (rewrite.style !== 'none') return rewrite.command

  // No port in the command. Heroku-style processes read $PORT, so exporting it
  // is the convention-matching fallback.
  return forcePort(command, 'none', false)
}

export const procfileDetector: ProjectDetector = {
  id: 'procfile',
  title: 'Procfile',
  files: [PROCFILE],
  detect: parseProcfile
}
