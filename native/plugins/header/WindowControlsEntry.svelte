<!-- The header's right end, wired to open preferences when some plugin provides them. -->
<script lang="ts">
  import { useKernel } from "../../kernel/kernel";
  import WindowControls from "./WindowControls.svelte";

  let { versionLabel }: { versionLabel?: string } = $props();

  const kernel = useKernel();

  /** Runs the preferences command if there is one. */
  function openPreferences(): void {
    if (kernel.commands.canRun("view.preferences")) {
      void kernel.commands.run("view.preferences");
    }
  }
</script>

<WindowControls {versionLabel} onsettings={openPreferences} />
