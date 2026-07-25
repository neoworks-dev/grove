// Types for project-type detection: the shapes a detector consumes and the
// service entries it proposes for workbench.yaml.
//
// Detectors are pure. They never touch the filesystem — the runner reads every
// file a detector declares and hands the contents in. That keeps each detector
// unit-testable from a string fixture and keeps all I/O and path validation in
// one place.

import type { ServiceConfig } from '../../shared/types'

// A service entry a detector believes belongs in workbench.yaml. The user
// reviews and edits these before anything is written.
export interface ServiceProposal extends ServiceConfig {
  // Proposed key under `services:` in workbench.yaml. The runner makes these
  // unique across detectors; a detector may propose a name another one already used.
  name: string
  // Detector id, surfaced in the wizard so the user can see where a proposal
  // came from and judge it.
  source: string
  // True when `command` was rewritten to consume a Grove-allocated port. False
  // means the command carries whatever port it always did, which may collide
  // between worktrees.
  usesPort: boolean
}

// Repo-relative path -> file contents. Files that do not exist are absent, so a
// detector must treat a missing key as "not this kind of project".
export type DetectorFiles = Record<string, string>

export interface ProjectDetector {
  id: string
  // Human-readable, shown in the wizard next to the proposals it produced.
  title: string
  // Repo-relative paths this detector wants read. Declared up front so the
  // runner can read the union once instead of per detector.
  files: string[]
  detect(files: DetectorFiles): ServiceProposal[]
}
