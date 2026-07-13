<script lang="ts">
  // Which-key: when the leader is held (≥300ms) or a multi-key sequence is in
  // progress, show the reachable next keys and their descriptions. Reads the
  // binding registry, so plugin-contributed shortcuts appear automatically.
  import { keymap } from '../lib/keymap.svelte'
  import { formatStep, type KeyStep } from '../lib/keySequence'

  interface Entry {
    token: string
    label: string
    group: string
    leaf: boolean
  }

  function display(step: KeyStep): string {
    const text = formatStep(step)
    if (text === 'space') return '␣'
    return text
  }

  const entries = $derived.by<Entry[]>(() => {
    const prefix = keymap.pendingSteps
    const byToken = new Map<string, Entry>()
    for (const binding of keymap.matching(prefix, keymap.pendingLeader)) {
      const steps = binding.sequence.steps
      if (steps.length <= prefix.length) continue
      const token = display(steps[prefix.length])
      const leaf = steps.length === prefix.length + 1
      if (!byToken.has(token)) {
        byToken.set(token, {
          token,
          label: leaf ? binding.description : `+${binding.group || 'more'}`,
          group: binding.group || '',
          leaf
        })
      }
    }
    return [...byToken.values()].sort((a, b) => a.token.localeCompare(b.token))
  })

  const visible = $derived(keymap.whichKeyVisible && entries.length > 0)
  const typed = $derived(keymap.pendingSteps.map(display).join(' '))
  const heading = $derived(keymap.pendingLeader ? 'Leader' : 'Keys')
</script>

{#if visible}
  <div
    class="pointer-events-none fixed bottom-8 right-3 z-overlay max-h-[60%] w-72 overflow-auto rounded-lg border border-line bg-elevated/95 shadow-overlay backdrop-blur"
  >
    <div class="flex items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="text-2xs font-semibold uppercase tracking-caps text-dim">{heading}</span>
      {#if typed}
        <span class="font-mono text-2xs text-violet">{keymap.pendingLeader ? '␣ ' : ''}{typed}</span>
      {/if}
    </div>
    <div class="py-1">
      {#each entries as entry (entry.token)}
        <div class="flex items-center gap-2 px-3 py-1 text-xs">
          <kbd
            class="min-w-5 rounded border border-line bg-surface px-1.5 py-0.5 text-center font-mono text-2xs text-default"
            >{entry.token}</kbd
          >
          <span class="truncate {entry.leaf ? 'text-muted' : 'text-violet'}">{entry.label}</span>
        </div>
      {/each}
    </div>
  </div>
{:else if keymap.hintVisible && keymap.hintTitle}
  <!-- Static hint panel (Vim operator-pending etc.) — same look, fixed content. -->
  <div
    class="pointer-events-none fixed bottom-8 right-3 z-overlay max-h-[60%] w-72 overflow-auto rounded-lg border border-line bg-elevated/95 shadow-overlay backdrop-blur"
  >
    <div class="flex items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="text-2xs font-semibold uppercase tracking-caps text-dim"
        >+{keymap.hintTitle}</span
      >
    </div>
    <div class="py-1">
      {#each keymap.hintEntries as entry (entry.keys)}
        <div class="flex items-center gap-2 px-3 py-1 text-xs">
          <kbd
            class="min-w-5 rounded border border-line bg-surface px-1.5 py-0.5 text-center font-mono text-2xs text-default"
            >{entry.keys}</kbd
          >
          <span class="truncate text-muted">{entry.description}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}
