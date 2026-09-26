<script lang="ts">
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'

  let {
    value,
    onchange,
    minimum,
    maximum,
    disabled = false
  }: {
    value: number
    onchange: (next: number) => void
    minimum?: number
    maximum?: number
    disabled?: boolean
  } = $props()

  /** Clamps a typed or stepped value into range and hands it on; ignores non-numbers. */
  function commit(raw: string | number): void {
    let next = Number(raw)
    if (!Number.isFinite(next)) return
    if (minimum !== undefined) next = Math.max(minimum, next)
    if (maximum !== undefined) next = Math.min(maximum, next)
    onchange(next)
  }
</script>

<div
  class="flex w-32 items-center rounded-lg border border-line bg-input transition-colors focus-within:border-line-strong hover:border-line-strong"
  class:opacity-40={disabled}
>
  <button
    class="flex h-9 w-8 shrink-0 items-center justify-center text-muted hover:text-default disabled:cursor-not-allowed"
    title="Decrease"
    {disabled}
    onclick={() => commit(value - 1)}
  >
    <MinusIcon size={12} />
  </button>
  <input
    type="number"
    class="min-w-0 flex-1 bg-transparent text-center text-sm text-default [appearance:textfield] focus:outline-none disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    {value}
    min={minimum}
    max={maximum}
    {disabled}
    onchange={(event) => commit(event.currentTarget.value)}
  />
  <button
    class="flex h-9 w-8 shrink-0 items-center justify-center text-muted hover:text-default disabled:cursor-not-allowed"
    title="Increase"
    {disabled}
    onclick={() => commit(value + 1)}
  >
    <PlusIcon size={12} />
  </button>
</div>
