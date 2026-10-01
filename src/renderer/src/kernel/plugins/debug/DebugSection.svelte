<script lang="ts">
  // One collapsible section of the Run and Debug view: a header with a caret,
  // a title and its own actions, over a body that hides when folded.
  import type { Snippet } from 'svelte'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon'

  let {
    title,
    open = $bindable(true),
    count,
    actions,
    children
  }: {
    title: string
    open?: boolean
    /** Shown after the title, for sections that list things. */
    count?: number
    actions?: Snippet
    children: Snippet
  } = $props()

  /** Folds or unfolds the section. */
  function toggle(): void {
    open = !open
  }
</script>

<section class="flex min-h-0 flex-col border-t border-line">
  <div class="flex h-7 shrink-0 items-center gap-1 px-2">
    <button
      class="flex min-w-0 flex-1 items-center gap-1 text-left text-2xs font-semibold uppercase tracking-caps text-dim hover:text-default"
      aria-expanded={open}
      onclick={toggle}
    >
      {#if open}
        <CaretDownIcon size={11} />
      {:else}
        <CaretRightIcon size={11} />
      {/if}
      <span class="truncate">{title}</span>
      {#if count !== undefined && count > 0}
        <span class="font-normal normal-case tracking-normal text-faint">{count}</span>
      {/if}
    </button>
    {#if actions}
      <div class="flex items-center gap-0.5">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if open}
    <div class="min-h-0 pb-1">
      {@render children()}
    </div>
  {/if}
</section>
