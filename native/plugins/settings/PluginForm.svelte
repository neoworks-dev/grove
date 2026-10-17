<!-- The right half of the settings page: the selected row's status, and a form of its settings. -->
<script lang="ts">
  import { Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { SettingField, SettingsEntry, SettingsService } from "../../kernel/settings";
  import { colors, fontSize } from "../theme/tokens";
  import FieldRow from "./FieldRow.svelte";

  interface Props {
    entry: SettingsEntry;
    settings: SettingsService;
  }

  let { entry, settings }: Props = $props();

  const fields = $derived(fieldsOf(entry));

  /** The row's settings as name and field pairs; none when its plugin declares no schema. */
  function fieldsOf(row: SettingsEntry): [string, SettingField][] {
    if (!row.schema) {
      return [];
    }
    return Object.entries(row.schema.fields);
  }

  /** The text under the title: the plugin the row loads, and how it went. */
  function describeStatus(): string {
    if (!entry.enabled) {
      return `${entry.plugin} · disabled`;
    }
    if (entry.message) {
      return `${entry.plugin} · ${entry.status}: ${entry.message}`;
    }
    return `${entry.plugin} · ${entry.status}`;
  }
</script>

<View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
  <View style={{ padding: 20, paddingBottom: 12, gap: 4, borderBottomWidth: 1, borderColor: colors.line }}>
    <Text style={{ fontSize: 16, fontWeight: "semibold", color: colors.text }}>{entry.rowId}</Text>
    <Text style={{ fontSize: fontSize.xs, color: entry.status === "failed" ? colors.red : colors.dim }}>{describeStatus()}</Text>
  </View>
  <Scroll style={{ flex: 1, minHeight: 0 }}>
    <View style={{ paddingX: 20, paddingBottom: 12 }}>
      {#if fields.length === 0}
        <Text style={{ paddingY: 16, fontSize: fontSize.sm, color: colors.dim }}>This plugin has no settings.</Text>
      {/if}
      {#each fields as [name, field] (name)}
        <FieldRow
          {name}
          {field}
          value={entry.values[name]}
          modified={entry.overridden.includes(name)}
          choices={field.type === "enum" ? settings.optionsOf(field) : []}
          onset={(value) => settings.set(entry.rowId, name, value)}
          onreset={() => settings.reset(entry.rowId, name)}
        />
      {/each}
    </View>
  </Scroll>
</View>
