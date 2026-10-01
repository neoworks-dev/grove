<script lang="ts">
  // One row of a variables tree — a scope, a variable, a watch or a console
  // result — with its children loaded from the adapter the first time it opens.
  // The parent re-keys the tree on every stop, so values never go stale.
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon'
  import type { DebugVariable } from '../../../../../shared/debug'
  import VariableNode from './VariableNode.svelte'
  import { messageOf } from './store.svelte'

  let {
    sessionId,
    name,
    value = '',
    type,
    variablesReference,
    depth = 0,
    expanded = false,
    heading = false
  }: {
    sessionId: string
    name: string
    value?: string
    type?: string
    variablesReference: number
    depth?: number
    expanded?: boolean
    /** A scope's row: its name only, set apart from the variables under it. */
    heading?: boolean
  } = $props()

  let open = $state(false)
  let children = $state<DebugVariable[] | null>(null)
  let loadError = $state<string | null>(null)

  const expandable = $derived(variablesReference > 0)

  // Scopes the parent wants open (the first, cheap one) start open.
  $effect(() => {
    if (expanded) {
      open = true
    }
  })

  $effect(() => {
    if (open && expandable && children === null) {
      void load()
    }
  })

  /** Fetches the children once. */
  async function load(): Promise<void> {
    try {
      children = await window.workbench.debugger.variables(sessionId, variablesReference)
    } catch (error) {
      loadError = messageOf(error)
      children = []
    }
  }

  /** Opens or closes an expandable row. */
  function toggle(): void {
    if (!expandable) {
      return
    }
    open = !open
  }
</script>

<div>
  <button
    class="flex h-5 w-full min-w-0 items-center gap-1 pr-2 text-left font-mono text-xs hover:bg-hover"
    style:padding-left="{8 + depth * 12}px"
    title={type ? `${name}: ${type}` : name}
    aria-expanded={expandable ? open : undefined}
    onclick={toggle}
  >
    <span class="grid w-3 shrink-0 place-items-center text-dim">
      {#if expandable && open}
        <CaretDownIcon size={10} />
      {:else if expandable}
        <CaretRightIcon size={10} />
      {/if}
    </span>
    {#if heading}
      <span class="truncate font-sans text-default">{name}</span>
    {:else}
      <span class="shrink-0 text-violet">{name}</span>
      {#if value !== ''}
        <span class="shrink-0 text-dim">=</span>
        <span class="min-w-0 truncate text-default">{value}</span>
      {/if}
    {/if}
  </button>
  {#if open && expandable}
    {#if loadError}
      <p class="py-0.5 text-2xs text-red" style:padding-left="{24 + depth * 12}px">{loadError}</p>
    {:else if children}
      {#each children as child, index (`${child.name}:${index}`)}
        <VariableNode
          {sessionId}
          name={child.name}
          value={child.value}
          type={child.type}
          variablesReference={child.variablesReference}
          depth={depth + 1}
        />
      {/each}
    {/if}
  {/if}
</div>
