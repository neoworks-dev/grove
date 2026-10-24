<!--
  The mark of a harness, in front of its name in the composer.
-->
<script lang="ts">
  import { Icon } from "@neoworks/svelte-gpui/ui";
  import { harnessMark } from "./harnessMarks";

  interface Props {
    harness: string;
    size?: number;
  }

  let { harness, size = 14 }: Props = $props();

  const mark = $derived(harnessMark(harness));
</script>

<Icon svg={mark.svg} {size} color={mark.color} />
