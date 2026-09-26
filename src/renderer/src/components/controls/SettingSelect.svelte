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

  /** Forwards a pick; single-select mode always hands back one value. */
  function pick(next: string | string[]): void {
    if (Array.isArray(next)) {
      return
    }
    onchange(next)
  }
</script>

<div class="w-48">
  <Select {value} {options} {disabled} onChange={pick} />
</div>
