<script lang="ts">
  // Picking labels, as labels. The old version was a column of checkboxes with
  // a colour dot beside each, which read as a settings form and grew unusable
  // past a dozen labels; this shows the pills themselves and filters them, so a
  // repository with thirty labels is still one glance and one keystroke.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import { github, loadLabels } from './store.svelte'

  let {
    selected,
    onchange,
    disabled = false
  }: {
    selected: string[]
    onchange: (next: string[]) => void
    disabled?: boolean
  } = $props()

  let query = $state('')

  $effect(() => {
    void loadLabels()
  })

  // Chosen labels first so a long list never hides what is already on the item,
  // then the rest in the repository's own order.
  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    const matches = github.labels.filter((label) => {
      if (needle.length === 0) return true
      if (label.name.toLowerCase().includes(needle)) return true
      return label.description.toLowerCase().includes(needle)
    })
    const chosen = matches.filter((label) => selected.includes(label.name))
    const rest = matches.filter((label) => !selected.includes(label.name))
    return [...chosen, ...rest]
  })

  function toggle(name: string): void {
    if (disabled) return
    if (selected.includes(name)) {
      onchange(selected.filter((entry) => entry !== name))
      return
    }
    onchange([...selected, name])
  }
</script>

<div class="flex min-h-0 flex-col gap-2">
  {#if github.labels.length > 8}
    <input
      class="w-full rounded-md border border-line bg-input px-2 py-1 text-2xs text-default outline-none placeholder:text-dim focus:border-line-strong"
      placeholder="Filter labels"
      bind:value={query}
      {disabled}
    />
  {/if}

  <FloatingScrollbar class="max-h-48 min-h-0">
    <div class="flex flex-wrap gap-1.5 pr-1">
      {#each visible as label (label.name)}
        <GithubLabelPill
          {label}
          interactive
          selected={selected.includes(label.name)}
          onclick={() => toggle(label.name)}
        />
      {/each}
    </div>
  </FloatingScrollbar>

  {#if github.labels.length === 0}
    <p class="text-2xs text-dim">No labels on this repository.</p>
  {:else if visible.length === 0}
    <p class="text-2xs text-dim">Nothing matches "{query}".</p>
  {/if}
</div>
