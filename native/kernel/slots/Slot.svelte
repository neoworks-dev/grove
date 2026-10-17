<!--
  Draws what plugins registered into a slot: every entry of a list slot in order, a single
  slot's winner, or a keyed slot's entry for `key`. Each entry sits in its own boundary, so
  one that throws shows a short notice in its place and the rest of the slot keeps drawing.
  `props` are handed to every entry's component on top of its own, which is how a host passes
  what only it knows, such as the pane an entry is drawn in.
-->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { useKernel } from "../kernel";
  import type { SlotEntry } from "./registry";

  let { name, key, props: hostProps }: { name: string; key?: string; props?: Record<string, unknown> } = $props();

  const kernel = useKernel();

  /** The entries to draw: those that answer to this key, or to none when no key is given. */
  function visibleEntries(): SlotEntry[] {
    return kernel.slots.entries(name).filter((entry) => entry.key === key);
  }

  /** The text a failed entry is replaced with. */
  function describeFailure(entryId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${entryId} failed: ${message}`;
  }
</script>

{#each visibleEntries() as entry (entry.id)}
  <svelte:boundary onerror={(error) => kernel.reportError(`slot ${name}`, error)}>
    <entry.component {...entry.props} {...hostProps} />
    {#snippet failed(error)}
      <Text style={{ color: "#f87171", fontSize: 12, padding: 4 }}>{describeFailure(entry.id, error)}</Text>
    {/snippet}
  </svelte:boundary>
{/each}
