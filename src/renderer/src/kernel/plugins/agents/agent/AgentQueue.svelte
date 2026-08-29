<script lang="ts">
  let {
    messages,
    onCancel
  }: {
    messages: { id: string; text: string }[]
    onCancel: (id: string) => void
  } = $props()
</script>

<!-- Messages waiting for the current run to finish; auto-submitted on a clean
     exit, removable until then. -->
<div
  class="flex max-h-20 shrink-0 flex-wrap gap-1 overflow-auto border-t border-line bg-elevated px-3 py-1.5"
>
  {#each messages as message (message.id)}
    <span
      class="flex max-w-full items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-muted"
    >
      <span class="truncate" title={message.text}>{message.text}</span>
      <button
        class="shrink-0 text-dim hover:text-red"
        title="Remove queued message"
        onclick={() => onCancel(message.id)}>✕</button
      >
    </span>
  {/each}
</div>
