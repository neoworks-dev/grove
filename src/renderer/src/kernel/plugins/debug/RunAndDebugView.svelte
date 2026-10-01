<script lang="ts">
  // The Run and Debug sidebar view: start a configuration, drive the session,
  // and read the paused program — variables, watches, call stack, breakpoints.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import PaneControls from '../../../components/PaneControls.svelte'
  import DebugToolbar from './DebugToolbar.svelte'
  import VariablesSection from './VariablesSection.svelte'
  import WatchSection from './WatchSection.svelte'
  import CallStackSection from './CallStackSection.svelte'
  import BreakpointsSection from './BreakpointsSection.svelte'
  import { debug } from './store.svelte'
  import { store } from '../../../lib/store.svelte'

  // The configurations depend on the worktree and on the file in the editor.
  $effect(() => {
    void store.selectedWorktreeId
    void store.activeTabPath
    void debug.refreshConfigurations()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex items-center gap-2 px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Run and Debug</span>
    <span class="flex-1"></span>
    <PaneControls />
  </div>
  <DebugToolbar />
  <FloatingScrollbar class="min-h-0 flex-1">
    <VariablesSection />
    <WatchSection />
    <CallStackSection />
    <BreakpointsSection />
  </FloatingScrollbar>
</div>
