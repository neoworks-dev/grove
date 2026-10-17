<!-- The pane's close button, at the end of its header row. -->
<script lang="ts">
  import x from "@phosphor-icons/core/regular/x.svg";
  import RowAction from "./RowAction.svelte";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
</script>

<RowAction icon={x} title="Close pane" onpress={onclose} />
