<!-- The header's middle pill, wired to open the file finder when some plugin provides one. -->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import CommandCenter from "./CommandCenter.svelte";

  let { label }: { label: string } = $props();

  const kernel = useKernel();

  /** Runs the file finder if there is one. */
  function openFinder(): void {
    if (kernel.commands.canRun("files.find")) {
      void kernel.commands.run("files.find");
    }
  }
</script>

<CommandCenter {label} onpress={openFinder} />
