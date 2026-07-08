<script lang="ts">
  import type { SettingEnumValue } from '../../../../shared/settings'

  let {
    value,
    options,
    onchange,
    disabled = false
  }: {
    value: string
    options: SettingEnumValue[]
    onchange: (next: string) => void
    disabled?: boolean
  } = $props()
</script>

<select
  class="rounded-md border border-line bg-input px-2 py-1 text-xs text-default disabled:opacity-50"
  {value}
  {disabled}
  onchange={(event) => onchange(event.currentTarget.value)}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
