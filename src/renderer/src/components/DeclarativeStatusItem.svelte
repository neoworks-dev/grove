<script lang="ts">
  // Status-bar item rendering a plugin's declarative descriptor (text +
  // optional tooltip/command), updated live via grove.ui.statusBar.update.
  import { pluginHost } from '../plugins/host.svelte'

  let { itemId }: { itemId: string } = $props()

  const item = $derived(pluginHost.statusItem(itemId))
</script>

{#if item}
  {#if item.command}
    <button
      class="hover:text-default"
      title={item.tooltip}
      onclick={() => void pluginHost.executeCommandById(item.command!, [])}
    >
      {item.text}
    </button>
  {:else}
    <span title={item.tooltip}>{item.text}</span>
  {/if}
{/if}
