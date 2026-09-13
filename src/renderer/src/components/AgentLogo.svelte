<script lang="ts">
  // The mark for an agent session, in tabs and worktree rows.
  //
  // A harness names its own icon in its descriptor (`HarnessInfo.icon`), which is
  // what the composer's harness picker draws; resolving it from the same place
  // here means a session and the picker that started it never show two different
  // logos. A harness grove cannot resolve — one that is no longer mounted — falls
  // back to a generic robot.

  import Icon from '@iconify/svelte'
  import RobotIcon from 'phosphor-svelte/lib/RobotIcon'
  import { catalog } from '../lib/agents/catalog.svelte'

  let {
    harness,
    size = 14,
    active = true
  }: { harness: string; size?: number; active?: boolean } = $props()

  // The listing may not have been fetched yet where no agent pane is open; the
  // load is cached, so asking for it here costs nothing after the first time.
  $effect(() => {
    void catalog.load()
  })

  const icon = $derived(catalog.harnessNamed(harness)?.icon)
</script>

<span
  class="inline-flex shrink-0"
  title={harness}
  class:opacity-40={!active}
  class:grayscale={!active}
>
  {#if icon}
    <Icon {icon} width={size} height={size} />
  {:else}
    <RobotIcon {size} />
  {/if}
</span>
