<script lang="ts">
  // Which-key: when the leader is held (≥300ms) or a multi-key sequence is in
  // progress, show the reachable next keys and their descriptions. Reads the
  // binding registry, so plugin-contributed shortcuts appear automatically.
  import { keymap } from '../lib/keymap.svelte'
  import { formatSequence, formatStep, type KeyStep } from '../lib/keySequence'
  import Kbd from './Kbd.svelte'

  // `inline` anchors the panel to the nearest positioned ancestor (the editor
  // pane) instead of the window, so nvim's pending keys are listed over the
  // buffer they apply to.
  let { inline = false }: { inline?: boolean } = $props()

  interface Entry {
    token: string
    label: string
    group: string
    leaf: boolean
  }

  function display(step: KeyStep): string {
    const text = formatStep(step)
    if (text === '<Space>') return '␣'
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
        let label = binding.description
        if (!leaf) {
          label = `+${groupName(steps.slice(0, prefix.length + 1), binding.group)}`
        }
        byToken.set(token, {
          token,
          label,
          group: binding.group || '',
          leaf
        })
      }
    }
    return [...byToken.values()].sort((a, b) => a.token.localeCompare(b.token))
  })

  /** A prefix's registered name, else the group of a binding under it. */
  function groupName(steps: KeyStep[], bindingGroup: string | undefined): string {
    const sequence = formatSequence({ leader: keymap.pendingLeader, steps })
    const registered = keymap.prefixLabel(sequence)
    if (registered !== null) return registered
    if (bindingGroup) return bindingGroup
    return 'more'
  }

  const visible = $derived(keymap.whichKeyVisible && entries.length > 0)
  const typed = $derived(keymap.pendingSteps.map(display).join(' '))
  const heading = $derived(keymap.pendingLeader ? 'Leader' : 'Keys')
</script>

{#if visible}
  <div
    class="pointer-events-none z-overlay max-h-[60%] w-72 overflow-auto rounded-lg border border-line bg-elevated/95 shadow-overlay backdrop-blur"
    class:fixed={!inline}
    class:bottom-8={!inline}
    class:right-3={!inline}
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
          <Kbd>{entry.token}</Kbd>
          <span class="truncate {entry.leaf ? 'text-muted' : 'text-violet'}">{entry.label}</span>
        </div>
      {/each}
    </div>
  </div>
{:else if keymap.hintVisible && keymap.hintTitle}
  <!-- Static hint panel (Vim operator-pending etc.) — same look, fixed content. -->
  <div
    class="pointer-events-none z-overlay max-h-[60%] w-72 overflow-auto rounded-lg border border-line bg-elevated/95 shadow-overlay backdrop-blur"
    class:fixed={!inline}
    class:bottom-8={!inline}
    class:right-3={!inline}
  >
    <div class="flex items-center gap-2 border-b border-line px-3 py-1.5">
      <span class="text-2xs font-semibold uppercase tracking-caps text-dim"
        >+{keymap.hintTitle}</span
      >
    </div>
    <div class="py-1">
      {#each keymap.hintEntries as entry (entry.keys)}
        <div class="flex items-center gap-2 px-3 py-1 text-xs">
          <Kbd>{entry.keys}</Kbd>
          <span class="truncate text-muted">{entry.description}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}
