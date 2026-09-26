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
  class="w-56 rounded-lg border border-line bg-input px-3 py-2 text-sm text-default transition-colors placeholder:text-faint hover:border-line-strong focus:border-line-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
  {value}
  {placeholder}
  {disabled}
  onchange={(event) => onchange(event.currentTarget.value)}
/>
