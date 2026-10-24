<!--
  One setting: its label and description on the left, the control for its type on the right, and
  under them whether it applies live, whether the user has changed it, and why a value was refused.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { SettingField, SettingValue } from "../../kernel/settings";
  import { colors, fontSize, radius } from "../theme/tokens";
  import ChoiceSelect from "./ChoiceSelect.svelte";
  import TextControl from "./TextControl.svelte";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  interface Props {
    name: string;
    field: SettingField;
    value: unknown;
    /** Whether the user's profile sets this field. */
    modified: boolean;
    /** The choices of an enum field. */
    choices: { value: string; label: string }[];
    /** Saves a new value; rejects with the reason it is refused. */
    onset: (value: SettingValue) => Promise<void>;
    /** Removes the user's override. */
    onreset: () => Promise<void>;
    /** Stacks the control under the text, for a narrow place such as the sidebar. */
    compact?: boolean;
  }

  let { name, field, value, modified, choices, onset, onreset, compact = false }: Props = $props();

  let problem = $state<string | null>(null);

  /** Runs a save or a reset and shows what went wrong, if anything. */
  async function attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      problem = null;
    } catch (error) {
      problem = describeProblem(error);
    }
  }

  function describeProblem(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /** Turns the text of a field into the value its type takes, and saves it. */
  function saveText(text: string): Promise<void> {
    if (field.type === "number") {
      return attempt(() => onset(Number(text)));
    }
    return attempt(() => onset(text));
  }

  /** What an empty text field says: that empty means no value, for fields where it does. */
  function placeholderOf(): string | undefined {
    if (field.type === "keybinding") {
      return "no key";
    }
    if (field.type === "color") {
      return "theme default";
    }
    return undefined;
  }

  const hint = $derived(field.live ? "Applies at once" : "Reloads the plugin");

  /** The layout of the whole row: text beside the control, or the control under the text. */
  const rowStyle = $derived(rowStyleOf());

  function rowStyleOf() {
    if (compact) {
      return { gap: 8, paddingY: 10, borderBottomWidth: 1, borderColor: colors.lineFaint };
    }
    return { direction: "row" as const, align: "center" as const, gap: 24, paddingY: 12, borderBottomWidth: 1, borderColor: colors.lineFaint };
  }

  /** The width of a dropdown: the page's wide one, or what fits the sidebar. */
  const choiceWidth = $derived(compactChoiceWidth());

  function compactChoiceWidth(): number {
    if (compact) {
      return 148;
    }
    return 264;
  }

  /** The width of a text box: the page's wide one, or what fits the sidebar. */
  const textWidth = $derived(compactWidth());

  function compactWidth(): number | undefined {
    if (compact) {
      return 148;
    }
    return undefined;
  }
</script>

<View style={rowStyle}>
  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
    <View style={{ direction: "row", align: "center", gap: 8 }}>
      <Text style={{ fontSize: fontSize.sm, color: colors.text }}>{field.label}</Text>
      {#if modified}
        <View style={{ size: 6, radius: 3, background: colors.accent }} />
      {/if}
    </View>
    {#if field.description}
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{field.description}</Text>
    {/if}
    <Text style={{ fontSize: fontSize.xxs, color: colors.faint }}>{name} · {hint}</Text>
    {#if problem}
      <Text style={{ fontSize: fontSize.xs, color: colors.red }}>{problem}</Text>
    {/if}
  </View>
  <View style={{ direction: "row", align: "center", gap: 8 }}>
    {#if field.type === "boolean"}
      <ToggleSwitch on={value === true} label={`Toggle ${field.label}`} onchange={(on) => attempt(() => onset(on))} />
    {:else if field.type === "enum"}
      <ChoiceSelect value={String(value)} label={`Choose ${field.label}`} options={choices} width={choiceWidth} onchange={(choice) => attempt(() => onset(choice))} />
    {:else}
      <TextControl
        value={String(value)}
        numeric={field.type === "number"}
        swatch={field.type === "color"}
        placeholder={placeholderOf()}
        width={textWidth}
        oncommit={saveText}
      />
    {/if}
    <Button
      style={{
        paddingX: 8,
        paddingY: 4,
        radius: radius.md,
        fontSize: fontSize.xxs,
        color: modified ? colors.muted : "transparent",
      }}
      hover={modified ? { background: colors.hover, color: colors.text } : undefined}
      disabled={!modified}
      onpress={() => attempt(onreset)}
    >
      <Text>Reset</Text>
    </Button>
  </View>
</View>
