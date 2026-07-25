// Detects services from a docker-compose file.
//
// Compose already declares named long-running services, so each one becomes a
// proposal. The proposed command drives compose rather than replacing it — the
// project's own compose file stays the source of truth for how a container runs.

import { load } from 'js-yaml'
import type { DetectorFiles, ProjectDetector, ServiceProposal } from './types'

// Both spellings are common and a repo may carry either.
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

// `"8080:80"`, `"127.0.0.1:8080:80"` or `8080:80` — the host port is what Grove
// needs to control, and it is the field before the final container port.
const PORT_MAPPING_PATTERN = /^(?:[\d.]+:)?(\d{2,5}):(\d{2,5})/

export function parseCompose(files: DetectorFiles): ServiceProposal[] {
  const source = COMPOSE_FILES.find((candidate) => candidate in files)
  if (!source) return []

  const services = readServices(files[source])
  if (!services) return []

  const proposals: ServiceProposal[] = []
  for (const [name, definition] of Object.entries(services)) {
    proposals.push(buildProposal(name, definition, source))
  }
  return proposals
}

function readServices(contents: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = load(contents)
  } catch {
    // A compose file we cannot parse is the user's problem to fix; guessing at
    // service names from a broken document would produce noise.
    return null
  }

  const services = (parsed as { services?: unknown })?.services
  if (!services || typeof services !== 'object') return null
  return services as Record<string, unknown>
}

function buildProposal(name: string, definition: unknown, source: string): ServiceProposal {
  const hostPort = firstHostPort(definition)

  const proposal: ServiceProposal = {
    name,
    // `--no-deps` so starting one service does not implicitly start the rest;
    // Grove supervises each service separately and shows them individually.
    command: `docker compose -f ${source} up --no-deps ${name}`,
    source: composeDetector.id,
    // Always false: the published port is pinned in the compose file, which we
    // do not rewrite, so this service ignores the worktree's port block and two
    // worktrees running it will collide. The wizard surfaces that.
    usesPort: false
  }

  if (hostPort === null) return proposal

  proposal.preview = `http://localhost:${hostPort}`
  proposal.health = `http://localhost:${hostPort}`
  return proposal
}

function firstHostPort(definition: unknown): number | null {
  const ports = (definition as { ports?: unknown })?.ports
  if (!Array.isArray(ports)) return null

  for (const entry of ports) {
    if (typeof entry !== 'string' && typeof entry !== 'number') continue

    const match = String(entry).match(PORT_MAPPING_PATTERN)
    if (!match) continue

    return Number(match[1])
  }

  return null
}

export const composeDetector: ProjectDetector = {
  id: 'compose',
  title: 'Docker Compose',
  files: COMPOSE_FILES,
  detect: parseCompose
}
