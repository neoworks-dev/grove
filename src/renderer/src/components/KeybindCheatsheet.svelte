<script lang="ts">
  // Full keybinding cheatsheet (leader ?). A glanceable, grouped reference of
  // every registered binding plus the Vim-adapter editor keys, complementing
  // the transient which-key popup and the editable Keyboard pane.
  import { keymap } from '../lib/keymap.svelte'
  import { VIM_LSP_KEYS } from '../lib/editorVimKeys'

  interface Row {
    keys: string
    description: string
  }
  interface Group {
    name: string
    rows: Row[]
  }

  function displayKeys(keys: string): string {
    return keys
      .split(' ')
      .map((step) => (step === 'leader' ? '␣' : step))
      .join(' ')
  }

  const groups = $derived.by<Group[]>(() => {
    const byGroup = new Map<string, Row[]>()
    for (const binding of keymap.effective) {
      const name = binding.group || 'General'
      const rows = byGroup.get(name) ?? []
      rows.push({ keys: displayKeys(binding.keys), description: binding.description })
      byGroup.set(name, rows)
    }
    // Vim editor LSP keys are handled by the CodeMirror Vim adapter, not the
    // keymap registry, so add them from their shared definition.
    byGroup.set(
      'Editor · LSP (Vim)',
      VIM_LSP_KEYS.map((key) => ({ keys: key.keys, description: key.description }))
    )
    return [...byGroup.entries()]
      .map(([name, rows]) => ({
        name,
        rows: rows.sort((a, b) => a.keys.localeCompare(b.keys))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  function close(): void {
    keymap.closeCheatsheet()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!keymap.cheatsheetOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if keymap.cheatsheetOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-overlay flex items-center justify-center bg-black/40 p-8"
    onclick={close}
  >
    <div
      class="max-h-full w-[760px] overflow-auto rounded-xl border border-line bg-elevated shadow-overlay"
      role="dialog"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
    >
      <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span class="text-sm font-semibold text-default">Keybindings</span>
        <button class="text-dim hover:text-default" onclick={close} aria-label="Close">✕</button>
      </div>
      <div class="grid grid-cols-2 gap-x-8 gap-y-5 p-4">
        {#each groups as group (group.name)}
          <div class="break-inside-avoid">
            <p class="mb-1.5 text-2xs font-semibold uppercase tracking-caps text-dim">
              {group.name}
            </p>
            {#each group.rows as row (row.keys + row.description)}
              <div class="flex items-center gap-2 py-0.5 text-xs">
                <kbd
                  class="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-default"
                  >{row.keys}</kbd
                >
                <span class="truncate text-muted">{row.description}</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
