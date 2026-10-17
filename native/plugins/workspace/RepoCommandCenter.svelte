<!--
  The header's middle pill with the open repository's name on it, in place of the generic title.
  Pressing it opens the command palette like the pill it replaces, or the file finder when there is no palette.
-->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import CommandCenter from "../header/CommandCenter.svelte";
  import { openPalette } from "../header/openPalette";
  import type { WorkspaceService } from "./service";

  let { workspace, fallbackLabel }: { workspace: WorkspaceService; fallbackLabel: string } = $props();

  const kernel = useKernel();
  const repo = $derived(workspace.repo());

  /** The repository's name, or the header's own title while none is open. */
  const label = $derived(repo === null ? fallbackLabel : repo.name);
</script>

<CommandCenter {label} onpress={() => openPalette(kernel)} />
