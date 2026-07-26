// Detects services from Makefile targets.
//
// Like package.json scripts, a Makefile mixes one-shot targets (build, clean,
// test) with long-running ones, and nothing marks which is which — so the same
// indicator-word heuristic applies, and the user reviews the result.

import type { DetectorFiles, ProjectDetector, ServiceProposal } from './types'
import { forcePort, localhostUrl } from './ports'
import { SERVICE_INDICATORS } from './packageScripts'

const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile']

// A target line: name, colon, optional prerequisites. Excludes `::` rules and
// pattern rules (`%.o:`), neither of which is something to run as a service.
const TARGET_PATTERN = /^([A-Za-z0-9_-]+)\s*:(?!=)[^=]*$/

export function parseMakefile(files: DetectorFiles): ServiceProposal[] {
  const source = MAKEFILES.find((candidate) => candidate in files)
  if (!source) return []

  const proposals: ServiceProposal[] = []
  const seen = new Set<string>()

  for (const rawLine of files[source].split('\n')) {
    // Recipe lines are tab-indented; only column-zero lines declare targets.
    if (rawLine.startsWith('\t')) continue

    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    if (line.startsWith('.')) continue // .PHONY and friends

    const match = line.match(TARGET_PATTERN)
    if (!match) continue

    const target = match[1]
    if (seen.has(target)) continue
    if (!looksLikeService(target)) continue

    seen.add(target)
    proposals.push(buildProposal(target))
  }

  return proposals
}

function looksLikeService(target: string): boolean {
  const name = target.toLowerCase()
  return SERVICE_INDICATORS.some((indicator) => name.includes(indicator))
}

function buildProposal(target: string): ServiceProposal {
  return {
    name: target,
    // The recipe is opaque to us, so the port can only be offered as an env var
    // and the target has to choose to honour it.
    command: forcePort(`make ${target}`, 'none', false),
    preview: localhostUrl(),
    health: localhostUrl(),
    source: makefileDetector.id,
    usesPort: true
  }
}

export const makefileDetector: ProjectDetector = {
  id: 'makefile',
  title: 'Makefile targets',
  files: MAKEFILES,
  detect: parseMakefile
}
