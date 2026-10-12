<script lang="ts">
  // The Git pane's left column: everything about the repository that is not its
  // history or its working tree — branches, remotes and tags, the stashes, the
  // safety snapshots Grove took before rewriting files, a search through the
  // commits, and a compare of any two refs.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { gitState } from '../state.svelte'
  import CheckpointsSection from './CheckpointsSection.svelte'
  import CompareSection from './CompareSection.svelte'
  import RefsSections from './RefsSections.svelte'
  import SearchSection from './SearchSection.svelte'
  import StashesSection from './StashesSection.svelte'

  let {
    worktreeId,
    worktreePath,
    currentBranch
  }: {
    worktreeId: string
    worktreePath: string
    currentBranch: string
  } = $props()

  /** Re-reads the shared git state, which every git view shows. */
  async function load(): Promise<void> {
    await gitState.reload()
  }
</script>

<FloatingScrollbar class="h-full">
  <div class="py-1">
    <RefsSections {worktreeId} {worktreePath} {currentBranch} onChanged={load} />
    <StashesSection {worktreeId} hasChanges={gitState.files.length > 0} onChanged={load} />
    <CheckpointsSection {worktreeId} refreshKey={gitState.revision} onChanged={load} />
    <SearchSection {worktreeId} />
    <CompareSection {worktreeId} {worktreePath} refreshKey={gitState.revision} />
  </div>
</FloatingScrollbar>
