<script lang="ts">
  // Placeholder for a leaf whose pane type isn't registered (yet). Kept in the
  // tree so a plugin registering later self-heals the layout reactively.
  let { paneTypeId }: { paneTypeId: string } = $props()
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
  <span class="text-xs text-dim">Pane type not available</span>
  <span class="font-mono text-2xs text-dim">{paneTypeId}</span>
</div>
