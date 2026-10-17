<!--
  The app's root once the kernel is up: it draws the `root` slot, which the frame plugin
  fills, hears the keys no focused element took and sends them to the keymap, and shows the
  profile rows that failed to load.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import Failures from "./Failures.svelte";
  import { provideKernel, type Kernel } from "./kernel";
  import type { KeyEventInput } from "./keymap";
  import Slot from "./slots/Slot.svelte";

  let { kernel }: { kernel: Kernel } = $props();

  // The kernel never changes for the life of this component, so reading it once is right.
  provideKernel(untrack(() => kernel));

  /** Sends a key that nothing focused took through the keymap's pipeline. */
  function handleKey(event: KeyEventInput): void {
    kernel.keymap.dispatch(event);
  }
</script>

<svelte:window onkeydown={handleKey} />

<View style={{ flex: 1, background: "#18181b" }}>
  <Slot name="root" />
  <Failures loader={kernel.loader} />
</View>
