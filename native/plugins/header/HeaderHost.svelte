<!--
  The header as the frame draws it: the `Header` layout with its three ends filled from the
  `header.left`, `header.center` and `header.right` list slots.
-->
<script lang="ts">
  import Slot from "../../kernel/slots/Slot.svelte";
  import Header from "./Header.svelte";
</script>

<Header>
  {#snippet left()}
    <Slot name="header.left" />
  {/snippet}
  {#snippet center()}
    <Slot name="header.center" />
  {/snippet}
  {#snippet right()}
    <Slot name="header.right" />
  {/snippet}
</Header>
