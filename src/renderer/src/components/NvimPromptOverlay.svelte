<script lang="ts">
  // The window-level surface for a Neovim prompt that has stopped an editor.
  // It is deliberately not drawn in the pane: nvim answers nothing while it
  // waits, so every request grove has in flight is queued behind this, and the
  // answer has to be typeable with focus in the terminal, the sidebar or
  // anywhere else. Keys go straight through; the answers nvim names in the
  // question also get a button, so the prompt is readable without knowing vim.
  import { nvimPrompts } from '../lib/nvim/prompts.svelte'
  import { nvimPromptChoices } from '../lib/nvim/blockingPrompt'
  import { encodeKeyEvent } from '../lib/nvim/keys'
  import { keyDispatch, KeyPriority } from '../lib/keyDispatch'
  import Kbd from './Kbd.svelte'

  const active = $derived(nvimPrompts.active)
  // The last line is the question; anything above it is the message that led
  // to it, which is where W13 and friends say what actually happened.
  const question = $derived.by(() => {
    if (!active) return ''
    return active.lines[active.lines.length - 1]
  })
  const message = $derived.by<string[]>(() => {
    if (!active) return []
    return active.lines.slice(0, -1)
  })
  const choices = $derived(nvimPromptChoices(question))

  function answer(keys: string): void {
    if (!active) return
    void window.workbench.nvim.input(active.nvimId, keys)
  }

  /** Every key is the prompt's while it waits — nvim decides what answers it. */
  function onKeyDown(event: KeyboardEvent): boolean {
    const keys = encodeKeyEvent(event)
    if (!keys) return false
    event.preventDefault()
    event.stopPropagation()
    answer(keys)
    return true
  }

  $effect(() => {
    if (!active) return
    return keyDispatch.subscribe(KeyPriority.nvimPrompt, onKeyDown)
  })
</script>

{#if active}
  <div
    class="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
    role="presentation"
  >
    <div
      class="w-[32rem] max-w-[90vw] rounded-lg border border-line bg-elevated p-4 shadow-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Neovim is waiting for an answer"
    >
      <h2 class="text-sm font-semibold text-default">The editor is waiting for an answer</h2>
      {#if message.length > 0}
        <pre
          class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-2 font-mono text-2xs text-muted">{message.join(
            '\n'
          )}</pre>
      {/if}
      <p class="mt-2 font-mono text-xs text-default">{question}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        {#if choices.length === 0}
          <button
            class="flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-xs text-accent-content hover:opacity-90"
            onclick={() => answer('<CR>')}
          >
            <Kbd>Enter</Kbd>
            Continue
          </button>
        {:else}
          {#each choices as choice (choice.key)}
            <button
              class="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-default hover:bg-hover"
              onclick={() => answer(choice.key)}
            >
              <Kbd>{choice.key}</Kbd>
              {choice.label}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
