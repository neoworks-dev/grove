<script lang="ts">
  // The selected process: its name, state and actions over its live output,
  // or, until it has run, over what it would run. Once there is output, the
  // header also carries find, wrap, copy and clear for it.
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon'
  import TextAlignLeftIcon from 'phosphor-svelte/lib/TextAlignLeftIcon'
  import ArrowLineRightIcon from 'phosphor-svelte/lib/ArrowLineRightIcon'
  import EraserIcon from 'phosphor-svelte/lib/EraserIcon'
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon'
  import { StatusBadge } from '@neoworks-dev/ui'
  import type { ProcessView } from '../messages'
  import IconAction from './IconAction.svelte'
  import ProcessActions from './ProcessActions.svelte'
  import ProcessInfo from './ProcessInfo.svelte'
  import ProcessTerminal from './ProcessTerminal.svelte'
  import { projectState } from './project.svelte'
  import { KEY_HINTS } from './keys'
  import { formatDuration, hasRun, statusLabel, statusTone } from './status'

  let { process }: { process: ProcessView } = $props()

  const ran = $derived(hasRun(process.status))
  const wrap = $derived(projectState.prefs.wrap)
  const uptime = $derived(runningFor(process, projectState.now))

  /** How long the process has been up, while it runs. */
  function runningFor(view: ProcessView, now: number): string {
    if (view.status !== 'running' || view.startedAt === null) return ''
    return `up ${formatDuration(now - view.startedAt)}`
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line-faint px-3">
    <span class="min-w-0 truncate text-xs font-semibold text-default">{process.name}</span>
    <StatusBadge tone={statusTone(process.status)}>{statusLabel(process)}</StatusBadge>
    {#if uptime}
      <span class="shrink-0 text-2xs text-dim">{uptime}</span>
    {/if}
    {#if process.restarts > 0}
      <span class="shrink-0 text-2xs text-amber">restarted {process.restarts}×</span>
    {/if}
    <div class="flex shrink-0 items-center gap-0.5">
      <ProcessActions {process} />
    </div>
    {#if ran}
      <span class="min-w-0 flex-1 truncate text-right font-mono text-2xs text-faint" title={process.command}>
        {process.command}
      </span>
      <div class="flex shrink-0 items-center gap-0.5 border-l border-line-faint pl-2">
        <IconAction
          icon={MagnifyingGlassIcon}
          title="Find in output ({KEY_HINTS.search})"
          onclick={() => projectState.openSearch()}
        />
        <IconAction
          icon={wrap ? ArrowLineRightIcon : TextAlignLeftIcon}
          title="{wrap ? 'Stop wrapping' : 'Wrap'} long lines ({KEY_HINTS.wrap})"
          onclick={() => projectState.setPrefs({ wrap: !wrap })}
        />
        <IconAction
          icon={CopyIcon}
          title="Copy output ({KEY_HINTS.copyOutput})"
          onclick={() => projectState.copyOutput(process.name)}
        />
        <IconAction
          icon={EraserIcon}
          title="Clear output ({KEY_HINTS.clearOutput})"
          onclick={() => projectState.clearOutput(process.name)}
        />
      </div>
    {/if}
  </div>
  {#if ran}
    <div class="min-h-0 flex-1 py-2 pl-3">
      <!-- A fresh terminal per process; it replays what the process printed. -->
      {#key process.name}
        <ProcessTerminal name={process.name} />
      {/key}
    </div>
  {:else}
    <ProcessInfo {process} />
  {/if}
</div>
