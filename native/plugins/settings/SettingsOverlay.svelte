<!--
  The settings page as the `overlay` slot draws it: a card over a dimmed window with the plugins
  of the profile on the left and the selected plugin's form on the right. Everything it shows
  comes from the `settings` service, which builds the forms from the schemas the plugins declare.
-->
<script lang="ts">
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import x from "@phosphor-icons/core/regular/x.svg";
  import type { SettingsEntry, SettingsService } from "../../kernel/settings";
  import { colors, fontSize, radius } from "../theme/tokens";
  import PluginForm from "./PluginForm.svelte";
  import PluginList from "./PluginList.svelte";
  import type { SettingsViewState } from "./state";

  interface Props {
    view: SettingsViewState;
    settings: SettingsService;
  }

  let { view, settings }: Props = $props();

  const entries = $derived(settings.entries());
  const selected = $derived(selectedEntry(entries, view.selectedRowId()));

  /** The row to show: the one chosen, else the first with settings, else the first row. */
  function selectedEntry(rows: SettingsEntry[], chosenId: string | null): SettingsEntry | undefined {
    const chosen = rows.find((entry) => entry.rowId === chosenId);
    if (chosen) {
      return chosen;
    }
    const withSettings = rows.find((entry) => entry.schema !== undefined);
    if (withSettings) {
      return withSettings;
    }
    return rows[0];
  }

  /** Enables or disables a row; a refusal is already in the log, so the switch just stays put. */
  function enable(rowId: string, enabled: boolean): void {
    void settings.setEnabled(rowId, enabled).catch(() => undefined);
  }
</script>

{#if view.isOpen()}
  <View
    style={{ position: "absolute", inset: 0, align: "center", justify: "center", background: colors.scrim }}
    onpress={() => view.close()}
  >
    <View
      style={{
        width: 940,
        maxWidth: "94%",
        height: 600,
        maxHeight: "92%",
        radius: 12,
        overflow: "hidden",
        background: colors.surface,
        borderWidth: 1,
        borderColor: colors.line,
        color: colors.text,
        shadow: { y: 24, blur: 64, color: "#000000aa" },
      }}
    >
      <View style={{ direction: "row", align: "center", height: 44, shrink: 0, paddingX: 16, borderBottomWidth: 1, borderColor: colors.line }}>
        <Text style={{ flex: 1, fontSize: fontSize.sm, fontWeight: "semibold", color: colors.text }}>Settings</Text>
        <Button
          style={{ size: 26, align: "center", justify: "center", radius: radius.md, color: colors.dim }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={() => view.close()}
        >
          <Icon svg={x} size={14} />
        </Button>
      </View>
      <View style={{ flex: 1, minHeight: 0, direction: "row" }}>
        {#if selected}
          <PluginList {entries} selectedRowId={selected.rowId} onselect={(rowId) => view.select(rowId)} onenable={enable} />
          {#key selected.rowId}
            <PluginForm entry={selected} {settings} />
          {/key}
        {/if}
      </View>
    </View>
  </View>
{/if}
