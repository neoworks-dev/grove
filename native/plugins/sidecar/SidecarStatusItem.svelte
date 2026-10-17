<!-- The sidecar's state in the status bar. It says nothing while the sidecar is running. -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { colors } from "../theme/tokens";
  import type { SidecarService } from "./service";

  let { sidecar }: { sidecar: SidecarService } = $props();

  const state = $derived(sidecar.status());
</script>

{#if state.state === "starting"}
  <Text style={{ color: colors.muted }}>Sidecar starting…</Text>
{:else if state.state === "exited"}
  <Text style={{ color: colors.red }}>Sidecar stopped{#if state.message}: {state.message}{/if}</Text>
{/if}
