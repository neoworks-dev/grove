<script lang="ts">
  let {
    value,
    onchange,
    disabled = false
  }: { value: string; onchange: (next: string) => void; disabled?: boolean } = $props()
</script>

<div
  class="flex w-40 items-center gap-2 rounded-lg border border-line bg-input py-1.5 pl-1.5 pr-3 transition-colors focus-within:border-line-strong hover:border-line-strong"
  class:opacity-40={disabled}
>
  <!-- The native picker, shrunk to a swatch: its chrome is hidden, only the colour shows. -->
  <input
    type="color"
    class="h-6 w-6 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0 disabled:cursor-not-allowed [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
    {value}
    {disabled}
    onchange={(event) => onchange(event.currentTarget.value)}
  />
  <input
    type="text"
    class="min-w-0 flex-1 bg-transparent font-mono text-xs text-default focus:outline-none disabled:cursor-not-allowed"
    {value}
    {disabled}
    onchange={(event) => onchange(event.currentTarget.value)}
  />
</div>
