<script lang="ts">
  // A field: its label (with a mark when it is required) over the input, the hint and, after a
  // failed submit, the error in the danger colour.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import { neouiPalette } from "./look";
  import { childPath } from "./paths";
  import { provideControl } from "./formcontext";
  import Node from "./Node.svelte";
  import { child, str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width }: NodeProps = $props();
  const p = neouiPalette;
  provideControl();

  const input = $derived(child(node, "input"));
  const hint = $derived(str(node, "hint"));
  const error = $derived(input === undefined ? undefined : str(input, "error"));
  const required = $derived(input?.props["required"] === true);
</script>

<View style={{ gap: 5 }}>
  <Text style={{ fontWeight: "medium", fontSize: p.text.body - 1 }}>
    {str(node, "label") ?? ""}{#if required}<Text style={{ color: p.danger }}>{" *"}</Text>{/if}
  </Text>
  {#if input}
    <Node node={input} path={childPath(path, "input")} {width} />
  {/if}
  {#if error}
    <Text style={{ color: p.danger, fontSize: p.text.body - 1 }}>{error}</Text>
  {:else if hint}
    <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>{hint}</Text>
  {/if}
</View>
