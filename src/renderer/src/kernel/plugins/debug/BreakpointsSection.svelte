<script lang="ts">
  // Every breakpoint, in any worktree, with a switch to turn it off, a jump to
  // its line and an editor for its condition, hit count and log message; and while a session runs, the exception filters its adapter
  // offers ("Uncaught Exceptions", "Raised Exceptions", …).
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon'
  import type {
    DebugBreakpoint,
    DebugBreakpointOptions,
    DebugExceptionFilter
  } from '../../../../../shared/debug'
  import DebugSection from './DebugSection.svelte'
  import BreakpointForm from './BreakpointForm.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { debug } from './store.svelte'
  import { store, openFileAtLine } from '../../../lib/store.svelte'

  const breakpoints = $derived(
    [...debug.snapshot.breakpoints].sort(
      (first, second) => first.path.localeCompare(second.path) || first.line - second.line
    )
  )
  const session = $derived(debug.focusedSession)
  const exceptionFilters = $derived(session?.exceptionFilters || [])

  /** The breakpoint whose options are open under its row. */
  let editingId = $state<string | null>(null)

  /** Opens a breakpoint's options under its row, or closes them. */
  function toggleEditing(breakpoint: DebugBreakpoint): void {
    if (editingId === breakpoint.id) {
      editingId = null
      return
    }
    editingId = breakpoint.id
  }

  /** Saves the options edited under a row and closes them. */
  function saveOptions(breakpoint: DebugBreakpoint, options: DebugBreakpointOptions): void {
    editingId = null
    void debug.saveBreakpoint(breakpoint.path, breakpoint.line, options)
  }

  /** Whether a breakpoint only stops sometimes, or logs instead of stopping. */
  function isSpecial(breakpoint: DebugBreakpoint): boolean {
    return Boolean(breakpoint.condition || breakpoint.hitCondition || breakpoint.logMessage)
  }

  /** What a breakpoint does besides stopping, in a line: its condition, hit count and log message. */
  function summaryOf(breakpoint: DebugBreakpoint): string {
    const parts: string[] = []
    if (breakpoint.condition) {
      parts.push(`when ${breakpoint.condition}`)
    }
    if (breakpoint.hitCondition) {
      parts.push(`hit ${breakpoint.hitCondition}`)
    }
    if (breakpoint.logMessage) {
      parts.push(`log ${breakpoint.logMessage}`)
    }
    return parts.join(' · ')
  }

  function fileName(path: string): string {
    return path.split('/').pop() || path
  }

  /** The breakpoint's directory, relative to the open worktree when inside it. */
  function directoryOf(path: string): string {
    const directory = path.slice(0, path.lastIndexOf('/'))
    const root = store.selectedWorktree?.path
    if (root && directory === root) {
      return ''
    }
    if (root && directory.startsWith(`${root}/`)) {
      return directory.slice(root.length + 1)
    }
    return directory
  }

  /** Why a running session did not accept a breakpoint, for its tooltip. */
  function statusOf(breakpoint: DebugBreakpoint): string {
    if (!breakpoint.enabled) {
      return 'Disabled'
    }
    if (!debug.active) {
      return ''
    }
    if (breakpoint.verified) {
      return 'Bound'
    }
    return breakpoint.message || 'Not bound: the adapter has no code on this line'
  }

  function open(breakpoint: DebugBreakpoint): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) {
      return
    }
    openFileAtLine(worktreeId, breakpoint.path, breakpoint.line)
  }

  /** Turns one exception filter on or off for the focused session. */
  function toggleFilter(filter: DebugExceptionFilter): void {
    if (!session) {
      return
    }
    const enabled = exceptionFilters
      .filter((candidate) => {
        if (candidate.filter === filter.filter) {
          return !candidate.enabled
        }
        return candidate.enabled
      })
      .map((candidate) => candidate.filter)
    void window.workbench.debugger.setExceptionFilters(session.id, enabled)
  }
</script>

<DebugSection title="Breakpoints" count={breakpoints.length}>
  {#snippet actions()}
    <RowAction
      icon={TrashIcon}
      title="Remove all breakpoints"
      disabled={breakpoints.length === 0}
      onclick={() => void window.workbench.debugger.removeAllBreakpoints()}
    />
  {/snippet}
  {#each exceptionFilters as filter (filter.filter)}
    <label
      class="flex h-5 items-center gap-2 px-3 text-xs text-default hover:bg-hover"
      title={filter.description}
    >
      <Checkbox
        size="sm"
        checked={filter.enabled}
        aria-label={filter.label}
        onchange={() => toggleFilter(filter)}
      />
      <span class="truncate">{filter.label}</span>
    </label>
  {/each}
  {#each breakpoints as breakpoint (breakpoint.id)}
    <div
      class="group/breakpoint flex h-5 items-center gap-2 px-3 text-xs hover:bg-hover"
      title={statusOf(breakpoint)}
    >
      <Checkbox
        size="sm"
        checked={breakpoint.enabled}
        aria-label="Breakpoint at {fileName(breakpoint.path)}:{breakpoint.line}"
        onchange={() =>
          void window.workbench.debugger.setBreakpointEnabled(breakpoint.id, !breakpoint.enabled)}
      />
      <!-- A dot like the gutter's sign: a diamond when it only stops sometimes,
           blue when it logs instead. -->
      <span
        class="size-2 shrink-0"
        class:rounded-full={!isSpecial(breakpoint)}
        class:rotate-45={isSpecial(breakpoint)}
        class:scale-90={isSpecial(breakpoint)}
        class:bg-red={breakpoint.enabled &&
          (breakpoint.verified || !debug.active) &&
          !breakpoint.logMessage}
        class:bg-blue={breakpoint.enabled &&
          (breakpoint.verified || !debug.active) &&
          Boolean(breakpoint.logMessage)}
        class:border={!breakpoint.enabled || (debug.active && !breakpoint.verified)}
        class:border-line-strong={!breakpoint.enabled || (debug.active && !breakpoint.verified)}
      ></span>
      <button
        class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onclick={() => open(breakpoint)}
      >
        <span class="shrink-0 text-default">{fileName(breakpoint.path)}</span>
        <span class="min-w-0 truncate text-2xs text-dim">{directoryOf(breakpoint.path)}</span>
      </button>
      {#if breakpoint.origin === 'agent'}
        <span class="shrink-0 rounded bg-raised px-1 text-2xs text-dim">agent</span>
      {/if}
      <span class="shrink-0 font-mono text-2xs text-dim group-hover/breakpoint:hidden"
        >{breakpoint.line}</span
      >
      <span class="hidden items-center group-hover/breakpoint:flex">
        <RowAction
          icon={PencilSimpleIcon}
          title="Edit condition, hit count and log message"
          onclick={() => toggleEditing(breakpoint)}
        />
        <RowAction
          icon={XIcon}
          title="Remove breakpoint"
          onclick={() => void window.workbench.debugger.removeBreakpoint(breakpoint.id)}
        />
      </span>
    </div>
    {#if isSpecial(breakpoint) && editingId !== breakpoint.id}
      <div
        class="-mt-0.5 truncate pb-0.5 pl-[2.75rem] pr-3 font-mono text-2xs text-dim"
        title={summaryOf(breakpoint)}
      >
        {summaryOf(breakpoint)}
      </div>
    {/if}
    {#if editingId === breakpoint.id}
      <div class="py-1 pl-[2.75rem] pr-3">
        <BreakpointForm
          initial={breakpoint}
          autofocus
          onsave={(options) => saveOptions(breakpoint, options)}
          oncancel={() => (editingId = null)}
        />
      </div>
    {/if}
  {/each}
  {#if breakpoints.length === 0}
    <p class="px-3 py-1 text-2xs text-dim">
      Click the editor's gutter or press F9 to add one; right-click it or press Shift+F9 for a
      condition or log message.
    </p>
  {/if}
</DebugSection>
