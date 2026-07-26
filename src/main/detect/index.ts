// Detector registry and runner for project-type detection.
//
// The runner owns all filesystem access: it reads the union of files every
// registered detector asked for, then hands the contents to each detector. That
// keeps detectors pure and makes adding one a matter of writing a file and
// registering it — no change here and none in the wizard.

import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ProjectDetector, DetectorFiles, ServiceProposal } from './types'
import { packageScriptsDetector } from './packageScripts'
import { composeDetector } from './compose'
import { procfileDetector } from './procfile'
import { makefileDetector } from './makefile'

const registry = new Map<string, ProjectDetector>()

// Replace semantics by id, matching the app's other registries.
export function registerDetector(detector: ProjectDetector): () => void {
  registry.set(detector.id, detector)
  return () => {
    registry.delete(detector.id)
  }
}

export function registeredDetectors(): ProjectDetector[] {
  return [...registry.values()]
}

for (const detector of [
  packageScriptsDetector,
  composeDetector,
  procfileDetector,
  makefileDetector
]) {
  registerDetector(detector)
}

// Detected services, ready for the wizard to render. Names are unique across
// detectors so they can be written straight into `services:`.
export async function detectServices(repoPath: string): Promise<ServiceProposal[]> {
  const detectors = registeredDetectors()
  const files = await readDeclaredFiles(repoPath, detectors)

  const proposals: ServiceProposal[] = []
  for (const detector of detectors) {
    proposals.push(...runDetector(detector, files))
  }

  return deduplicateNames(proposals)
}

async function readDeclaredFiles(
  repoPath: string,
  detectors: ProjectDetector[]
): Promise<DetectorFiles> {
  const wanted = new Set<string>()
  for (const detector of detectors) {
    for (const file of detector.files) wanted.add(file)
  }

  const entries = await Promise.all(
    [...wanted].map(async (relativePath) => {
      const contents = await readIfPresent(join(repoPath, relativePath))
      return { relativePath, contents }
    })
  )

  const files: DetectorFiles = {}
  for (const entry of entries) {
    // Absent files stay absent rather than becoming empty strings, so a detector
    // can distinguish "no compose file" from "empty compose file".
    if (entry.contents === null) continue
    files[entry.relativePath] = entry.contents
  }
  return files
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// One broken detector must not lose every other detector's proposals.
function runDetector(detector: ProjectDetector, files: DetectorFiles): ServiceProposal[] {
  try {
    return detector.detect(files)
  } catch (error) {
    console.warn(`[detect] ${detector.id} failed:`, error)
    return []
  }
}

// Two detectors can legitimately propose the same name — a `dev` npm script and
// a `dev` Makefile target. Suffix later ones with their source so both survive
// for the user to choose between.
function deduplicateNames(proposals: ServiceProposal[]): ServiceProposal[] {
  const used = new Set<string>()
  const result: ServiceProposal[] = []

  for (const proposal of proposals) {
    result.push({ ...proposal, name: uniqueName(proposal, used) })
  }

  return result
}

function uniqueName(proposal: ServiceProposal, used: Set<string>): string {
  if (!used.has(proposal.name)) {
    used.add(proposal.name)
    return proposal.name
  }

  const qualified = `${proposal.name}-${proposal.source}`
  if (!used.has(qualified)) {
    used.add(qualified)
    return qualified
  }

  let counter = 2
  while (used.has(`${qualified}-${counter}`)) counter += 1
  used.add(`${qualified}-${counter}`)
  return `${qualified}-${counter}`
}

export type { ProjectDetector, ServiceProposal, DetectorFiles } from './types'
