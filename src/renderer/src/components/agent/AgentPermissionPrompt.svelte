<script lang="ts">
  let {
    title,
    path,
    diffLines,
    onApprove,
    onDeny,
    onShowChange
  }: {
    title: string
    path?: string | null
    diffLines: string[]
    onApprove: (remember: boolean) => void
    onDeny: (message: string) => void
    onShowChange: () => void
  } = $props()

  let denyReasonMode = $state(false)
  let denyReason = $state('')
  let index = $state(0)
  let rootEl = $state<HTMLDivElement>()

  interface Choice {
    label: string
    class: string
    run: () => void
  }

  const choices = $derived.by<Choice[]>(() => {
    const list: Choice[] = [
      { label: 'Yes', class: 'bg-green text-action-fg', run: () => onApprove(false) },
      {
        label: "Yes, don't ask again for this",
        class: 'bg-violet text-action-fg',
        run: () => onApprove(true)
      }
    ]
    if (path) {
      list.push({
        label: 'Open file in editor',
        class: 'border border-line hover:bg-hover',
        run: onShowChange
      })
    }
    list.push({
      label: 'No',
      class: 'border border-line text-red hover:bg-hover',
      run: () => onDeny('')
    })
    list.push({
      label: 'No, with reason…',
      class: 'border border-line text-dim hover:bg-hover',
      run: () => (denyReasonMode = true)
    })
    return list
  })

  // Focus the prompt so arrow keys and Enter reach it.
  $effect(() => {
    if (!denyReasonMode) queueMicrotask(() => rootEl?.focus())
  })

  function onKey(event: KeyboardEvent): void {
    if (denyReasonMode) return
    const count = choices.length
    if (count === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      index = (index + 1) % count
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      index = (index - 1 + count) % count
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choices[index].run()
    }
  }

  function lineClass(line: string): string {
    if (line.startsWith('@@')) return 'text-dim'
    if (line.startsWith('+')) return 'bg-green-soft text-green'
    if (line.startsWith('-')) return 'bg-red-soft text-red'
    return 'text-muted'
  }
</script>

<div
  bind:this={rootEl}
  class="rounded-md border border-amber/40 bg-amber-soft p-2 outline-none"
  tabindex="-1"
  onkeydown={onKey}
>
  <div class="mb-2 text-xs text-default">{title}</div>
  {#if path}
    <div class="mb-2 truncate font-mono text-2xs text-muted">{path}</div>
  {/if}
  {#if diffLines.length > 0}
    <div
      class="mb-2 max-h-56 overflow-auto rounded border border-line bg-canvas font-mono text-2xs leading-snug"
    >
      {#each diffLines as line, lineIndex (lineIndex)}
        <div class="whitespace-pre px-2 {lineClass(line)}">{line}</div>
      {/each}
    </div>
  {/if}
  {#if denyReasonMode}
    <textarea
      class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
      placeholder="Reason for denying…"
      bind:value={denyReason}
    ></textarea>
    <div class="flex gap-2">
      <button
        class="rounded-md bg-red px-3 py-1 text-xs text-action-fg"
        onclick={() => onDeny(denyReason)}
      >
        Deny with reason
      </button>
      <button
        class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
        onclick={() => (denyReasonMode = false)}
      >
        Cancel
      </button>
    </div>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each choices as choice, choiceIndex (choice.label)}
        <button
          class="rounded-md px-3 py-1.5 text-left text-xs outline-none {choice.class} {choiceIndex ===
          index
            ? 'ring-2 ring-default'
            : ''}"
          onclick={choice.run}
        >
          {choice.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
