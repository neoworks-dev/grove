<script lang="ts">
  // Floating inline-edit prompt, anchored over the selection inside a NvimPane.
  // Enter dispatches the edit; Shift+Enter inserts a newline; Escape cancels.
  // A plain textarea, so the keymap's INPUT/TEXTAREA guard keeps the leader and
  // nvim keys from hijacking typing.
  import { inlineEdit } from '../lib/inlineEdit.svelte'

  let { leafId }: { leafId: string } = $props()

  let inputEl = $state<HTMLTextAreaElement>()
  let text = $state('')

  const open = $derived(inlineEdit.promptOpen && inlineEdit.promptLeafId === leafId)

  $effect(() => {
    if (open) queueMicrotask(() => inputEl?.focus())
  })

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      text = ''
      inlineEdit.cancelPrompt()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      const trimmed = text.trim()
      text = ''
      if (trimmed) void inlineEdit.submitPrompt(trimmed)
      else inlineEdit.cancelPrompt()
    }
  }
</script>

{#if open}
  <div class="absolute left-2 right-2 z-30" style="top: {inlineEdit.promptAnchorY}px">
    <div class="overflow-hidden rounded-lg border border-line bg-elevated shadow-xl">
      <div class="flex items-center gap-2 px-2.5 pt-1.5 text-2xs text-dim">
        <span class="font-medium text-muted">Inline edit</span>
        <span class="truncate font-mono">@{inlineEdit.promptRefLabel}</span>
        <span class="ml-auto rounded bg-surface px-1.5 py-0.5 uppercase tracking-wide">
          {inlineEdit.mode}
        </span>
      </div>
      <textarea
        bind:this={inputEl}
        bind:value={text}
        onkeydown={onKey}
        rows="2"
        placeholder="Describe the change… (Enter to run, Esc to cancel)"
        class="w-full resize-none bg-transparent px-2.5 py-2 text-sm text-default outline-none placeholder:text-dim"
      ></textarea>
    </div>
  </div>
{/if}
