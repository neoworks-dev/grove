<script lang="ts">
  let {
    messages,
    onCancel
  }: {
    messages: { id: string; text: string }[]
    /** Absent for messages already handed to the harness, which cannot be taken back. */
    onCancel?: (id: string) => void
  } = $props()
</script>

<!-- Messages written while the agent was busy, waiting for it to take them up:
     queued ones are auto-submitted on a clean exit and removable until then;
     steered ones reach the model with its next request. Drawn like a sent user
     message, only muted, since that is what each becomes once taken up. -->
<div class="flex max-h-32 shrink-0 flex-col gap-1 overflow-auto bg-elevated px-3 py-2">
  {#each messages as message (message.id)}
    <div
      class="flex min-w-0 items-start gap-2 text-base text-muted"
      title={onCancel ? undefined : 'Waiting for the agent to take it up'}
    >
      <span class="min-w-0 flex-1 truncate" title={message.text}>{message.text}</span>
      {#if onCancel}
        <button
          class="shrink-0 text-dim hover:text-red"
          title="Remove queued message"
          onclick={() => onCancel(message.id)}>✕</button
        >
      {/if}
    </div>
  {/each}
</div>
