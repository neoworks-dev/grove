<script lang="ts">
  import Select from '@neoworks-dev/ui/Select'
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

  // The Select shows no selection for an empty value, so an option standing for
  // "empty" (e.g. Automatic) is shown as the placeholder instead.
  const emptyLabel = $derived(options.find((option) => option.value === '')?.label)

  /** Forwards a pick; single-select mode always hands back one value. */
  function pick(next: string | string[]): void {
    if (Array.isArray(next)) {
      return
    }
    onchange(next)
  }
</script>

<div class="w-48">
  <Select {value} {options} {disabled} placeholder={emptyLabel} onChange={pick} />
</div>
