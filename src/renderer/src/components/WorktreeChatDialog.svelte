<script lang="ts">
  // Shared chat for a worktree: the user and every agent running there exchange
  // messages. Agents post/read via the grove-chat MCP tools; here the user
  // reads the live feed and posts. History loads on open; new messages arrive
  // via the store's event:worktree-chat subscription.
  import { store } from '../lib/store.svelte'
  import type { WorktreeChatMessage } from '../../../shared/types'

  let { worktree, onClose }: { worktree: { id: string; name: string }; onClose: () => void } =
    $props()

  let draft = $state('')
  let sending = $state(false)

  const messages = $derived<WorktreeChatMessage[]>(store.worktreeChat[worktree.id] || [])

  // Seed the store with history the first time the dialog opens (the live
  // subscription only carries messages sent while listening).
  $effect(() => {
    const id = worktree.id
    if (store.worktreeChat[id]) return
    void window.workbench.chat.history(id).then((history) => {
      store.worktreeChat = { ...store.worktreeChat, [id]: history }
    })
  })

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
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

<div
  class="fixed inset-0 z-modal flex items-center justify-center bg-black/60"
  role="button"
  tabindex="0"
  onclick={onClose}
  onkeydown={(event) => event.key === 'Escape' && onClose()}
>
  <div
    class="flex h-[70vh] w-[32rem] flex-col rounded-lg border border-line bg-surface p-4 shadow-lg"
    role="dialog"
    tabindex="0"
    onclick={(event) => event.stopPropagation()}
    onkeydown={() => {}}
  >
    <h2 class="mb-1 text-sm font-semibold">Chat — {worktree.name}</h2>
    <p class="mb-3 text-2xs text-dim">
      Shared with every agent running in this worktree. They can message you and each other.
    </p>

    <div class="mb-3 min-h-0 flex-1 space-y-2 overflow-auto">
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
              class="max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-xs {message.from
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

    <div class="flex gap-2">
      <textarea
        class="h-10 flex-1 resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
        placeholder="Message the agents…"
        bind:value={draft}
        onkeydown={onKeydown}
      ></textarea>
      <button
        class="shrink-0 rounded-md bg-action px-3 py-1.5 text-xs text-action-fg disabled:opacity-50"
        disabled={sending || !draft.trim()}
        onclick={send}
      >
        Send
      </button>
    </div>
  </div>
</div>
