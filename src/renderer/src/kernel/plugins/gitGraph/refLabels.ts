// The labels the graph hangs on commits: every branch, remote branch and tag
// that points at one, and HEAD when it is detached.

import type { BranchRef, RefList, TagRef } from '../../../../../shared/types'

export type RefLabel =
  | { kind: 'head'; name: string }
  | { kind: 'branch'; name: string; branch: BranchRef }
  | { kind: 'remote'; name: string; branch: BranchRef }
  | { kind: 'tag'; name: string; tag: TagRef }

/**
 * The labels on each commit, keyed by SHA. HEAD only gets a label of its own
 * when no branch is checked out — otherwise the current branch's label says it.
 */
export function labelsBySha(refs: RefList, head: string | null): Map<string, RefLabel[]> {
  const labels = new Map<string, RefLabel[]>()
  const add = (sha: string, label: RefLabel): void => {
    const existing = labels.get(sha)
    if (existing) existing.push(label)
    else labels.set(sha, [label])
  }
  const onBranch = refs.local.some((branch) => branch.current)
  if (head !== null && !onBranch) add(head, { kind: 'head', name: 'HEAD' })
  for (const branch of refs.local) add(branch.sha, { kind: 'branch', name: branch.name, branch })
  for (const branch of refs.remote) add(branch.sha, { kind: 'remote', name: branch.name, branch })
  for (const tag of refs.tags) add(tag.sha, { kind: 'tag', name: tag.name, tag })
  return labels
}
