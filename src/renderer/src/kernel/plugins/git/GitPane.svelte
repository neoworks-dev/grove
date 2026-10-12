<script lang="ts">
  // The Git pane: the commit graph and the GitHub dashboard behind one strip of
  // tabs. Each tab is the pane it used to be, with its own header under the
  // strip; the window's controls sit on the strip, so either tab can close it.
  // The tab shown is remembered with the pane.
  import { untrack } from 'svelte'
  import GitGraphPane from './graph/GitGraphPane.svelte'
  import GithubPane from './github/GithubPane.svelte'
  import { GIT_TABS, gitPane, isGitTab } from './pane.svelte'
  import PaneControls from '../../../components/PaneControls.svelte'

  let {
    state: paneState,
    updateState
  }: {
    state: Record<string, unknown>
    updateState: (patch: Record<string, unknown>) => void
  } = $props()

  // A restored pane opens on the tab it was left on; read once, on mount.
  untrack(() => {
    if (isGitTab(paneState.tab)) gitPane.tab = paneState.tab
  })

  $effect(() => {
    const tab = gitPane.tab
    if (paneState.tab !== tab) updateState({ tab })
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex h-7 shrink-0 items-center gap-0.5 border-b border-line px-1.5" role="tablist">
    {#each GIT_TABS as tab (tab.id)}
      <button
        role="tab"
        aria-selected={gitPane.tab === tab.id}
        class="shrink-0 rounded-md px-1.5 py-0.5 text-xs hover:bg-hover"
        class:text-default={gitPane.tab === tab.id}
        class:text-dim={gitPane.tab !== tab.id}
        onclick={() => (gitPane.tab = tab.id)}
      >
        {tab.title}
      </button>
    {/each}
    <span class="flex-1"></span>
    <PaneControls />
  </div>

  <div class="min-h-0 flex-1">
    {#if gitPane.tab === 'graph'}
      <GitGraphPane state={paneState} {updateState} />
    {:else}
      <GithubPane />
    {/if}
  </div>
</div>
