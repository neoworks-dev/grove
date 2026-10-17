<!--
  The window's content while the kernel boots, and the message if it cannot. Once the kernel
  is up, `KernelShell` takes over.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import KernelShell from "./KernelShell.svelte";
  import type { Kernel } from "./kernel";

  let { boot }: { boot: Promise<Kernel> } = $props();
</script>

{#await boot}
  <View style={{ flex: 1, background: "#18181b" }} />
{:then kernel}
  <KernelShell {kernel} />
{:catch error}
  <View style={{ flex: 1, background: "#18181b", padding: 24, gap: 8 }}>
    <Text style={{ color: "#fecaca", fontSize: 16, fontWeight: "bold" }}>Grove could not start</Text>
    <Text style={{ color: "#fca5a5", fontSize: 13 }}>{error instanceof Error ? error.message : String(error)}</Text>
  </View>
{/await}
