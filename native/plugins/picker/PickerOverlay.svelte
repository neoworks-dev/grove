<!--
  The picker as the `overlay` slot draws it: nothing while closed, and while open a dimmed window
  with the card on it. Each time the picker opens the card is built afresh, so the query and the
  highlighted row start over.
-->
<script lang="ts">
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { EditorService } from "../editor/service";
  import { colors } from "../theme/tokens";
  import PickerCard from "./PickerCard.svelte";
  import type { PickerService } from "./service";

  let { picker, editor }: { picker: PickerService; editor: EditorService } = $props();

  const session = $derived(picker.session());
</script>

{#if session}
  {#key session}
    <View
      style={{ position: "absolute", inset: 0, align: "center", paddingTop: 48, background: colors.scrim }}
      onpress={() => picker.close()}
    >
      <PickerCard {picker} {session} {editor} />
    </View>
  {/key}
{/if}
