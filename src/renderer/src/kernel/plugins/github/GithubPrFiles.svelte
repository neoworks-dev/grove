<script lang="ts">
  // The Files half of a pull request: what it changes, as the directory tree it
  // changed them in. A flat list of paths says nothing about where in the
  // repository the work landed, and truncates the interesting end of a long
  // path to fit the pane.
  //
  // Opening a file checks the pull request out as a worktree first, so what you
  // read is the real tree at that revision — every file, not only the changed
  // ones — with the changed file opened beside the merge base's copy of it.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubPrFileRow from './GithubPrFileRow.svelte'
  import { buildPrFileTree } from './prFileTree'
  import { checkoutPr, github, loadPrDiff, openPrFile } from './store.svelte'
  import type { GithubItemDetail, GithubPrFile } from '../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  const diff = $derived(github.prDiffs[detail.number])
  const tree = $derived(diff ? buildPrFileTree(diff.files) : [])
  let openPath = $state<string | null>(null)

  // Directories are open unless the user folded one, so the changed files are
  // all in view the moment the tab is.
  let collapsed = $state<Record<string, boolean>>({})

  // Fetched when the tab is first looked at rather than when the item is
  // selected: the first load pulls the pull request into the repository, which
  // is the slow part of all of this.
  $effect(() => {
    if (!detail.baseRefName) return
    void loadPrDiff(detail.number, detail.baseRefName)
  })

  function toggle(path: string): void {
    collapsed = { ...collapsed, [path]: !collapsed[path] }
  }

  async function openFile(file: GithubPrFile): Promise<void> {
    openPath = file.path
    await openPrFile(detail, file)
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex items-center gap-2 border-b border-line px-4 py-1.5 text-2xs text-dim">
    <span>{diff ? diff.files.length : (detail.changedFiles ?? 0)} files</span>
    <button
      class="ml-auto rounded border border-line px-2 py-0.5 hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={github.busy || !detail.baseRefName}
      title="Create a worktree on this pull request's head and select it"
      onclick={() => checkoutPr(detail)}
    >
      Check out
    </button>
  </div>

  <FloatingScrollbar class="min-h-0 flex-1">
    <div class="flex flex-col py-1">
      {#if github.prDiffLoading && !diff}
        <p class="px-4 py-6 text-xs text-dim">Fetching the pull request…</p>
      {:else if !diff}
        <p class="px-4 py-6 text-xs text-dim">No changed files.</p>
      {:else}
        {#each tree as node (node.path)}
          <GithubPrFileRow {node} {collapsed} {openPath} onToggle={toggle} onOpen={openFile} />
        {/each}
      {/if}
    </div>
  </FloatingScrollbar>
</div>
