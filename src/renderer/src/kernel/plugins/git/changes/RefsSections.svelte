<script lang="ts">
  // Branches, remote branches and tags, from one read of the repository's refs.
  // Branches start open; remotes and tags, which a busy repository has many of,
  // start collapsed.
  import BranchRow from './BranchRow.svelte'
  import GitSection from './GitSection.svelte'
  import TagRow from './TagRow.svelte'
  import { gitState } from '../state.svelte'

  let {
    worktreeId,
    worktreePath,
    currentBranch,
    onChanged
  }: {
    worktreeId: string
    worktreePath: string
    currentBranch: string
    onChanged: () => void
  } = $props()

  const refs = $derived(gitState.refs)
  let branchesOpen = $state(true)
  let remotesOpen = $state(false)
  let tagsOpen = $state(false)
</script>

<GitSection title="Branches" count={refs.local.length} bind:open={branchesOpen}>
  <div role="tree">
    {#each refs.local as branch (branch.name)}
      <BranchRow {worktreeId} {worktreePath} {branch} {currentBranch} {onChanged} />
    {:else}
      <p class="px-3 py-2 text-xs text-dim">No branches yet.</p>
    {/each}
  </div>
</GitSection>

{#if refs.remote.length > 0}
  <GitSection title="Remotes" count={refs.remote.length} bind:open={remotesOpen}>
    <div role="tree">
      {#each refs.remote as branch (branch.name)}
        <BranchRow {worktreeId} {worktreePath} {branch} {currentBranch} {onChanged} />
      {/each}
    </div>
  </GitSection>
{/if}

{#if refs.tags.length > 0}
  <GitSection title="Tags" count={refs.tags.length} bind:open={tagsOpen}>
    <div role="tree">
      {#each refs.tags as tag (tag.name)}
        <TagRow {worktreeId} {worktreePath} {tag} {currentBranch} {onChanged} />
      {/each}
    </div>
  </GitSection>
{/if}
