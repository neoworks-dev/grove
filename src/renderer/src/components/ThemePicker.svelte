<script lang="ts">
  import { themePicker } from '../lib/themepicker.svelte'
  import { applyColorTheme } from '../lib/store.svelte'
  import { availableThemes, currentThemeName } from '../lib/themes'
  import type { ColorTheme } from '../lib/themes'

  let activeIndex = $state(0)
  let dialogEl = $state<HTMLDivElement>()
  let themes = $state<ColorTheme[]>([])
  // Theme active when the picker opened, restored if the user cancels.
  let originalName = $state('')

  // Snapshot the registered themes and current selection each time the picker
  // opens. Themes installed as extensions appear here once registered.
  $effect(() => {
    if (!themePicker.open) return
    themes = availableThemes()
    originalName = currentThemeName()
    const current = themes.findIndex((theme) => theme.name === originalName)
    activeIndex = current >= 0 ? current : 0
    queueMicrotask(() => dialogEl?.focus())
  })

  // Temporarily apply the focused theme so the whole app previews it live.
  function preview(index: number): void {
    if (index < 0 || index >= themes.length) return
    activeIndex = index
    applyColorTheme(themes[index].name)
  }

  // Enter keeps the previewed theme (already applied); just close.
  function commit(): void {
    themePicker.close()
  }

  // Escape / backdrop restores the theme that was active on open.
  function cancel(): void {
    applyColorTheme(originalName)
    themePicker.close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      cancel()
      return
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      preview(Math.min(activeIndex + 1, themes.length - 1))
      return
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      preview(Math.max(activeIndex - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }

  // A few palette swatches so each row hints at its colors.
  function swatches(theme: ColorTheme): string[] {
    const p = theme.palette
    return [p.bg, p.surface, p.primary, p.ctxGreen, p.ctxBlue, p.ctxViolet]
  }
</script>

{#if themePicker.open}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[12vh]"
    role="button"
    tabindex="0"
    onclick={cancel}
    onkeydown={(event) => event.key === 'Escape' && cancel()}
  >
    <div
      bind:this={dialogEl}
      class="flex max-h-[64vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="border-b border-line px-3 py-2 text-2xs font-medium text-dim">
        Switch Color Theme <span class="text-faint">· ↑↓ preview · enter apply · esc cancel</span>
      </div>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        {#each themes as theme, index (theme.name)}
          <button
            class="flex w-full items-center gap-3 px-3 py-2 text-left {index === activeIndex
              ? 'bg-hover'
              : ''} hover:bg-hover"
            onmousemove={() => preview(index)}
            onclick={commit}
          >
            <span class="flex shrink-0 gap-0.5">
              {#each swatches(theme) as color (color)}
                <span
                  class="h-3.5 w-3.5 rounded-sm border border-line/60"
                  style="background-color: {color}"
                ></span>
              {/each}
            </span>
            <span class="truncate text-xs {index === activeIndex ? 'text-default' : 'text-muted'}"
              >{theme.label}</span
            >
            <span class="ml-auto shrink-0 text-2xs uppercase tracking-caps text-faint"
              >{theme.scheme}</span
            >
          </button>
        {/each}
        {#if themes.length === 0}
          <p class="px-3 py-4 text-xs text-dim">No themes registered.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
