<!-- The header's middle pill, wired to open the command palette, or the file finder when there is no palette. -->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import CommandCenter from "./CommandCenter.svelte";
  import { openPalette } from "./openPalette";

  let { label }: { label: string } = $props();

  const kernel = useKernel();
</script>

<CommandCenter {label} onpress={() => openPalette(kernel)} />
