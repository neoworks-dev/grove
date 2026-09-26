<script lang="ts">
  import Checkbox from '@neoworks-dev/ui/Checkbox'

  let {
    value,
    onchange,
    disabled = false
  }: { value: boolean; onchange: (next: boolean) => void; disabled?: boolean } = $props()

  /** Hands on the box's new state. */
  function toggle(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    onchange(input.checked)
  }
</script>

<Checkbox checked={value} {disabled} onchange={toggle} />
