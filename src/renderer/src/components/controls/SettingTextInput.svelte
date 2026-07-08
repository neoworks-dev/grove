<script lang="ts">
  let {
    value,
    onchange,
    placeholder = '',
    disabled = false
  }: {
    value: string
    onchange: (next: string) => void
    placeholder?: string
    disabled?: boolean
  } = $props()
</script>

<input
  type="text"
  class="w-56 rounded-md border border-line bg-input px-2 py-1 text-xs text-default disabled:opacity-50"
  {value}
  {placeholder}
  {disabled}
  onchange={(event) => onchange(event.currentTarget.value)}
/>
