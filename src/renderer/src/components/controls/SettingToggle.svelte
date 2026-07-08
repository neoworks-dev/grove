<script lang="ts">
  let {
    value,
    onchange,
    disabled = false
  }: { value: boolean; onchange: (next: boolean) => void; disabled?: boolean } = $props()
</script>

<button
  role="switch"
  aria-checked={value}
  {disabled}
  class="relative h-5 w-9 shrink-0 rounded-full border border-line transition-colors {value
    ? 'bg-accent'
    : 'bg-surface'} disabled:opacity-50"
  onclick={() => onchange(!value)}
>
  <span
    class="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-elevated transition-all {value
      ? 'left-4.5'
      : 'left-0.5'}"
  ></span>
</button>
