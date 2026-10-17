<!-- An on and off switch: a track with a knob at one end. `label` is for the test harness (see `HiddenLabel`). -->
<script lang="ts">
  import { Button, View } from "@neoworks/svelte-gpui/ui";
  import { colors } from "../theme/tokens";
  import HiddenLabel from "./HiddenLabel.svelte";

  interface Props {
    on: boolean;
    label?: string;
    disabled?: boolean;
    onchange: (on: boolean) => void;
  }

  let { on, label, disabled = false, onchange }: Props = $props();
</script>

<Button
  {disabled}
  style={{
    width: 30,
    height: 16,
    shrink: 0,
    radius: 8,
    padding: 2,
    justify: on ? "end" : "start",
    background: on ? colors.accent : colors.lineStrong,
    opacity: disabled ? 0.45 : 1,
    transition: 120,
  }}
  onpress={() => onchange(!on)}
>
  <View style={{ size: 12, radius: 6, background: "#ffffff" }} />
  {#if label}
    <HiddenLabel text={label} />
  {/if}
</Button>
