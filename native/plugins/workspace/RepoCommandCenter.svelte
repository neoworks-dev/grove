<!--
  The header's middle pill with the open repository's name on it, in place of the generic title.
  Pressing it does what it did before: it opens the file finder when some plugin provides one.
-->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import CommandCenter from "../header/CommandCenter.svelte";
  import type { WorkspaceService } from "./service";

  let { workspace, fallbackLabel }: { workspace: WorkspaceService; fallbackLabel: string } = $props();

  const kernel = useKernel();
  const repo = $derived(workspace.repo());

  /** The repository's name, or the header's own title while none is open. */
  const label = $derived(repo === null ? fallbackLabel : repo.name);

  /** Runs the file finder if there is one. */
  function openFinder(): void {
    if (kernel.commands.canRun("files.find")) {
      void kernel.commands.run("files.find");
    }
  }
</script>

<CommandCenter {label} onpress={openFinder} />
