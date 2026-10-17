<!--
  Lists the profile rows that failed to load, in the corner of the window, so a broken plugin
  is visible without opening the log. A press on a row dismisses it until that row fails again.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { LoaderService, RowReport } from "./profile";

  let { loader }: { loader: LoaderService } = $props();

  let dismissed = $state<Record<string, string | undefined>>({});

  /** The failures that have not been dismissed; a changed message counts as a new failure. */
  function openFailures(): RowReport[] {
    return loader.failures().filter((report) => dismissed[report.id] !== report.message);
  }

  /** Hides a failure until its message changes. */
  function dismiss(report: RowReport): void {
    dismissed[report.id] = report.message;
  }
</script>

{#if openFailures().length > 0}
  <View style={{ position: "absolute", right: 12, bottom: 40, gap: 6, maxWidth: 520 }}>
    {#each openFailures() as report (report.id)}
      <View
        style={{ padding: 10, radius: 6, background: "#3b1219", borderColor: "#f87171", borderWidth: 1, gap: 2 }}
        onpress={() => dismiss(report)}
      >
        <Text style={{ color: "#fecaca", fontSize: 13, fontWeight: "bold" }}>
          Plugin "{report.id}" failed to load
        </Text>
        <Text style={{ color: "#fca5a5", fontSize: 12 }}>{report.message}</Text>
      </View>
    {/each}
  </View>
{/if}
