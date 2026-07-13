<script lang="ts">
  // Floating inline-edit prompt, hovering just above the selection inside a
  // NvimPane (so it doesn't cover the selected code). Enter dispatches the edit;
  // Shift+Enter inserts a newline; Escape cancels. A plain textarea, so the
  // keymap's INPUT/TEXTAREA guard keeps the leader and nvim keys from hijacking
  // typing.
  import { inlineEdit } from '../lib/inlineEdit.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'

  let { leafId }: { leafId: string } = $props()

  let inputEl = $state<HTMLTextAreaElement>()
  let boxEl = $state<HTMLDivElement>()
  let text = $state('')
  let placedTop = $state(0)

  const open = $derived(inlineEdit.promptOpen && inlineEdit.promptLeafId === leafId)

  const GAP = 4

  $effect(() => {
    if (!open) return
    queueMicrotask(() => inputEl?.focus())
  })

  // Place the box above the selection's first line; if there isn't room above,
  // drop it just below that line. Centered placement is handled purely by CSS.
  $effect(() => {
    if (!open || inlineEdit.promptCentered) return
    void inlineEdit.promptAnchorY
    queueMicrotask(() => {
      if (!boxEl) return
      const anchor = inlineEdit.promptAnchorY
      const above = anchor - boxEl.offsetHeight - GAP
      if (above >= 0) {
        placedTop = above
        return
      }
      const lineHeight = nvimSessionFor(leafId)?.cellHeight || 18
      placedTop = anchor + lineHeight + GAP
    })
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
  <!-- Inset past the line-number gutter (left) and clear of the minimap (right)
       so the box never overlaps either. Capped width keeps it compact. -->
  <div
    class="absolute left-14 right-[72px] z-30 {inlineEdit.promptCentered
      ? 'top-1/2 -translate-y-1/2'
      : ''}"
    style={inlineEdit.promptCentered ? '' : `top: ${placedTop}px`}
  >
    <div
      bind:this={boxEl}
      class="max-w-[520px] overflow-hidden rounded-lg border border-line bg-elevated shadow-xl"
    >
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
