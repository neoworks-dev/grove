<script lang="ts">
  // Vim-style mode indicator for the statusline. Shows the active pane's mode
  // (declared via PaneType.modes, reported live by the pane); hidden entirely
  // for mode-less panes.
  import { keymap } from '../lib/keymap.svelte'

  const LABELS: Record<string, { text: string; class: string }> = {
    normal: { text: 'NORMAL', class: 'bg-green-soft text-green' },
    insert: { text: 'INSERT', class: 'bg-blue-soft text-blue' },
    visual: { text: 'VISUAL', class: 'bg-amber-soft text-amber' },
    'visual-line': { text: 'V-LINE', class: 'bg-amber-soft text-amber' },
    'visual-block': { text: 'V-BLOCK', class: 'bg-amber-soft text-amber' },
    replace: { text: 'REPLACE', class: 'bg-red-soft text-red' },
    terminal: { text: 'TERMINAL', class: 'bg-surface text-default' }
  }

  const label = $derived.by(() => {
    const mode = keymap.mode
    if (!mode) return null
    const known = LABELS[mode]
    if (known) return known
    return { text: mode.toUpperCase(), class: 'bg-surface text-muted' }
  })
</script>

{#if label}
  <span class="rounded px-1.5 py-px font-mono text-2xs font-semibold {label.class}">
    {label.text}
  </span>
{/if}
