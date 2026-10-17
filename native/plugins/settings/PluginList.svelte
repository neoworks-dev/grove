<!--
  The left half of the settings page: every row of the profile with a dot for how it loaded and a
  switch that enables or disables it. Choosing a row shows its form.
-->
<script lang="ts">
  import { Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { SettingsEntry } from "../../kernel/settings";
  import { colors, fontSize, radius } from "../theme/tokens";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  interface Props {
    entries: SettingsEntry[];
    selectedRowId: string;
    onselect: (rowId: string) => void;
    onenable: (rowId: string, enabled: boolean) => void;
  }

  let { entries, selectedRowId, onselect, onenable }: Props = $props();

  /** The colour of a row's status dot. */
  function dotColor(entry: SettingsEntry): string {
    if (!entry.enabled) {
      return colors.faint;
    }
    if (entry.status === "active") {
      return colors.green;
    }
    if (entry.status === "failed") {
      return colors.red;
    }
    return colors.amber;
  }
</script>

<View style={{ width: 260, shrink: 0, borderRightWidth: 1, borderColor: colors.line, background: colors.raised }}>
  <Text style={{ padding: 16, paddingBottom: 8, fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>Plugins</Text>
  <Scroll style={{ flex: 1, minHeight: 0 }}>
    <View style={{ paddingX: 8, paddingBottom: 8, gap: 2 }}>
      {#each entries as entry (entry.rowId)}
        <View
          style={{
            direction: "row",
            align: "center",
            gap: 8,
            paddingX: 10,
            paddingY: 7,
            radius: radius.md,
            background: entry.rowId === selectedRowId ? colors.hover : "transparent",
          }}
          hover={{ background: colors.hover }}
          onpress={() => onselect(entry.rowId)}
        >
          <View style={{ size: 8, radius: 4, shrink: 0, background: dotColor(entry) }} />
          <Text
            style={{
              flex: 1,
              minWidth: 0,
              truncate: true,
              fontSize: fontSize.sm,
              color: entry.enabled ? colors.text : colors.dim,
            }}>{entry.rowId}</Text
          >
          {#if entry.schema}
            <View style={{ size: 5, radius: 3, shrink: 0, background: colors.accent }} />
          {/if}
          <ToggleSwitch on={entry.enabled} label={`Toggle ${entry.rowId}`} disabled={entry.essential} onchange={(on) => onenable(entry.rowId, on)} />
        </View>
      {/each}
    </View>
  </Scroll>
</View>
