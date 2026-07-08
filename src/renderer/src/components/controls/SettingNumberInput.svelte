<script lang="ts">
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

  function commit(raw: string): void {
    let next = Number(raw)
    if (!Number.isFinite(next)) return
    if (minimum !== undefined) next = Math.max(minimum, next)
    if (maximum !== undefined) next = Math.min(maximum, next)
    onchange(next)
  }
</script>

<input
  type="number"
  class="w-24 rounded-md border border-line bg-input px-2 py-1 text-xs text-default disabled:opacity-50"
  {value}
  min={minimum}
  max={maximum}
  {disabled}
  onchange={(event) => commit(event.currentTarget.value)}
/>
