<script lang="ts">
  // The top of the Run and Debug view. With nothing running: the launch
  // configurations to pick from and a start button, plus an install offer when
  // the picked one's adapter is missing. While a session runs: its name, why it
  // stopped, and the stepping controls.
  import Select from '@neoworks-dev/ui/Select'
  import Button from '@neoworks-dev/ui/Button'
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon'
  import PauseIcon from 'phosphor-svelte/lib/PauseIcon'
  import ArrowArcRightIcon from 'phosphor-svelte/lib/ArrowArcRightIcon'
  import ArrowLineDownIcon from 'phosphor-svelte/lib/ArrowLineDownIcon'
  import ArrowLineUpIcon from 'phosphor-svelte/lib/ArrowLineUpIcon'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import StopIcon from 'phosphor-svelte/lib/StopIcon'
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { debug } from './store.svelte'

  // Short: the label shares a row with the stepping controls.
  const STOP_REASONS: Record<string, string> = {
    breakpoint: 'On breakpoint',
    'function breakpoint': 'On breakpoint',
    'data breakpoint': 'On breakpoint',
    step: 'Paused',
    exception: 'On exception',
    pause: 'Paused',
    entry: 'On entry',
    goto: 'Paused'
  }

  const options = $derived(
    debug.configurations.map((entry) => ({
      value: entry.key,
      label: entry.name,
      description: describe(entry.source, entry.adapterReady, entry.installPackage)
    }))
  )
  const selected = $derived(debug.selectedConfiguration)
  const session = $derived(debug.focusedSession)
  const stopLabel = $derived.by(() => {
    if (!session || session.state !== 'stopped') {
      return null
    }
    const reason = session.stopReason || 'pause'
    return STOP_REASONS[reason] || 'Paused'
  })

  /** What a configuration's option says under its name. */
  function describe(source: string, ready: boolean, installPackage: string | null): string {
    let origin = 'launch.json'
    if (source === 'adapter') {
      origin = 'Current file'
    }
    if (ready) {
      return origin
    }
    if (installPackage) {
      return `${origin} · needs ${installPackage}`
    }
    return `${origin} · no adapter found`
  }

  /** Picks a configuration; single-select mode hands back one value. */
  function pick(next: string | string[]): void {
    if (Array.isArray(next)) {
      return
    }
    debug.selectedConfigurationKey = next
  }
</script>

{#if !debug.active}
  <div class="flex flex-col gap-2 px-3 pb-3">
    {#if debug.configurations.length === 0}
      <p class="text-xs text-dim">
        Nothing to debug yet. Open a file a debug adapter knows, or add configurations to
        <span class="font-mono">.vscode/launch.json</span>.
      </p>
    {:else}
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <Select
            size="sm"
            value={selected?.key || ''}
            {options}
            placeholder="Pick a configuration"
            onChange={pick}
          />
        </div>
        <span class="block" title="Start debugging (F5)">
          <Button
            size="sm"
            variant="primary"
            icon={PlayIcon}
            disabled={!selected ||
              debug.starting ||
              (!selected.adapterReady && !selected.installPackage)}
            onclick={() => void debug.startSelected()}
          >
            {#if debug.installing}
              Installing…
            {:else if debug.starting}
              Starting…
            {:else}
              Start
            {/if}
          </Button>
        </span>
      </div>
      {#if selected && !selected.adapterReady}
        <div
          class="flex items-center gap-2 rounded-md bg-amber-soft px-2 py-1.5 text-xs text-amber"
        >
          {#if selected.installPackage}
            <span class="min-w-0 flex-1">
              The {selected.type} adapter is not installed. Start installs
              <span class="font-mono">{selected.installPackage}</span> with Mason.
            </span>
            <RowAction
              icon={DownloadSimpleIcon}
              title="Install {selected.installPackage}"
              disabled={debug.installing !== null}
              onclick={() => void debug.install(selected.installPackage || '')}
            />
          {:else}
            <span>No debug adapter is known for type "{selected.type}".</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{:else if session}
  <div class="flex flex-col gap-1.5 px-3 pb-2">
    <div class="truncate text-xs text-default" title={session.name}>{session.name}</div>
    <div class="flex items-center gap-1">
      {#if session.state === 'stopped'}
        <RowAction icon={PlayIcon} title="Continue (F5)" onclick={() => void debug.continue()} />
      {:else}
        <RowAction
          icon={PauseIcon}
          title="Pause"
          disabled={session.state !== 'running'}
          onclick={() => void debug.pause()}
        />
      {/if}
      <RowAction
        icon={ArrowArcRightIcon}
        title="Step over (F10)"
        disabled={session.state !== 'stopped'}
        onclick={() => void debug.stepOver()}
      />
      <RowAction
        icon={ArrowLineDownIcon}
        title="Step into (F11)"
        disabled={session.state !== 'stopped'}
        onclick={() => void debug.stepInto()}
      />
      <RowAction
        icon={ArrowLineUpIcon}
        title="Step out (Shift+F11)"
        disabled={session.state !== 'stopped'}
        onclick={() => void debug.stepOut()}
      />
      <RowAction icon={ArrowClockwiseIcon} title="Restart" onclick={() => void debug.restart()} />
      <RowAction icon={StopIcon} title="Stop (Shift+F5)" onclick={() => void debug.stop()} />
      <span class="flex-1"></span>
      {#if stopLabel}
        <span class="truncate text-2xs text-amber">{stopLabel}</span>
      {:else if session.state === 'initializing'}
        <span class="text-2xs text-dim">Starting…</span>
      {:else}
        <span class="text-2xs text-dim">Running</span>
      {/if}
    </div>
    {#if stopLabel && session.stopDescription && session.stopReason === 'exception'}
      <div class="rounded-md bg-red-soft px-2 py-1 font-mono text-2xs text-red">
        {session.stopDescription}
      </div>
    {/if}
  </div>
{/if}
