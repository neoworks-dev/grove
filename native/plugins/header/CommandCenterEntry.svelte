<!-- The header's middle pill, wired to open the command palette, or the file finder when there is no palette. -->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import CommandCenter from "./CommandCenter.svelte";

  let { label }: { label: string } = $props();

  const kernel = useKernel();

  /** Opens the command palette, or the file finder if the palette is not loaded. */
  function openPalette(): void {
    for (const commandId of ["palette.open", "files.find"]) {
      if (kernel.commands.canRun(commandId)) {
        void kernel.commands.run(commandId);
        return;
      }
    }
  }
</script>

<CommandCenter {label} onpress={openPalette} />
