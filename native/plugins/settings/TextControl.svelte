<!--
  A text field for a string, a number, a colour or a key sequence. The text is a draft until the
  field is left or Enter is pressed, so a half-typed value is never written to the profile.
-->
<script lang="ts">
  import { Input, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, radius } from "../theme/tokens";

  interface Props {
    value: string;
    /** Takes only digits and number punctuation. */
    numeric?: boolean;
    /** Draws a swatch of the colour in the text. */
    swatch?: boolean;
    placeholder?: string;
    oncommit: (text: string) => void;
  }

  let { value, numeric = false, swatch = false, placeholder, oncommit }: Props = $props();

  let draft = $state("");

  $effect(() => {
    draft = value;
  });

  const swatchColor = $derived(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(draft) ? draft : "transparent");
</script>

<View style={{ direction: "row", align: "center", gap: 8 }}>
  {#if swatch}
    <View style={{ size: 18, radius: radius.sm, borderWidth: 1, borderColor: colors.line, background: swatchColor }} />
  {/if}
  <Input
    value={draft}
    {numeric}
    {placeholder}
    oninput={(text) => (draft = text)}
    oncommit={(text) => oncommit(text)}
    style={{
      width: swatch ? 238 : 264,
      paddingX: 10,
      paddingY: 6,
      radius: radius.md,
      fontSize: fontSize.xs,
      background: colors.input,
      borderWidth: 1,
      borderColor: colors.line,
      color: colors.text,
    }}
    focus={{ borderColor: colors.accent }}
  />
</View>
