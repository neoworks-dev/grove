// Types for project-type detection: the shapes a detector consumes and the
// service entries it proposes for workbench.yaml.
//
// Detectors are pure. They never touch the filesystem — the runner reads every
// file a detector declares and hands the contents in. That keeps each detector
// unit-testable from a string fixture and keeps all I/O and path validation in
// one place.

// ServiceProposal lives in shared/types because it crosses IPC to the wizard.
// The runner makes `name` unique across detectors, so a detector may freely
// propose a name another one already used.
export type { ServiceProposal } from '../../shared/types'
import type { ServiceProposal } from '../../shared/types'

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
