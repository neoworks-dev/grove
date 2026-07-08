<script lang="ts">
  let {
    value,
    onchange,
    disabled = false
  }: { value: string; onchange: (next: string) => void; disabled?: boolean } = $props()
</script>

<div class="flex items-center gap-2">
  <input
    type="color"
    class="h-6 w-8 cursor-pointer rounded border border-line bg-transparent disabled:opacity-50"
    {value}
    {disabled}
    onchange={(event) => onchange(event.currentTarget.value)}
  />
  <input
    type="text"
    class="w-24 rounded-md border border-line bg-input px-2 py-1 font-mono text-2xs text-default disabled:opacity-50"
    {value}
    {disabled}
    onchange={(event) => onchange(event.currentTarget.value)}
  />
</div>
