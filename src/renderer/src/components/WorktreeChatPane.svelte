<script lang="ts">
  // Shared chat for the selected worktree, docked on the right like the agent
  // pane. The user and every agent running in that worktree exchange messages;
  // agents post/read via the grove-chat MCP tools. History loads when a worktree
  // is first shown; live messages arrive via the store's event:worktree-chat
  // subscription. Follows the selected worktree — no per-instance dialog.
  import { store } from '../lib/store.svelte'
  import type { WorktreeChatMessage } from '../../../shared/types'

  const worktree = $derived(store.selectedWorktree)
  const messages = $derived<WorktreeChatMessage[]>(
    worktree ? store.worktreeChat[worktree.id] || [] : []
  )

  let draft = $state('')
  let sending = $state(false)

  // Seed history the first time a worktree is shown (the live subscription only
  // carries messages sent while listening).
  $effect(() => {
    const id = worktree?.id
    if (!id || store.worktreeChat[id]) return
    void window.workbench.chat.history(id).then((history) => {
      store.worktreeChat = { ...store.worktreeChat, [id]: history }
    })
  })

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !worktree) return
    sending = true
    try {
      await window.workbench.chat.send(worktree.id, text)
      draft = ''
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      sending = false
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if !worktree}
    <p class="px-3 py-4 text-xs text-dim">Select a worktree to chat with its agents.</p>
  {:else}
    <p class="border-b border-line px-3 py-2 text-2xs text-dim">
      Shared with every agent running in <span class="text-default">{worktree.name}</span>. They can
      message you and each other.
    </p>

    <div class="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
      {#if messages.length === 0}
        <p class="py-6 text-center text-xs text-dim">No messages yet.</p>
      {:else}
        {#each messages as message (message.id)}
          <div class="flex flex-col {message.from.kind === 'user' ? 'items-end' : 'items-start'}">
            <div class="mb-0.5 text-2xs text-dim">
              {message.from.kind === 'user' ? 'you' : message.from.name}
              {#if message.to}<span class="text-violet"> → {message.to}</span>{/if}
            </div>
            <div
              class="max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-xs {message.from
                .kind === 'user'
                ? 'bg-amber-soft text-default'
                : 'bg-raised text-default'}"
            >
              {message.text}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="flex gap-2 border-t border-line p-2">
      <textarea
        class="h-10 flex-1 resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
        placeholder="Message the agents…"
        bind:value={draft}
        onkeydown={onKeydown}
      ></textarea>
      <button
        class="shrink-0 self-end rounded-md bg-action px-3 py-1.5 text-xs text-action-fg disabled:opacity-50"
        disabled={sending || !draft.trim()}
        onclick={send}
      >
        Send
      </button>
    </div>
  {/if}
</div>
