<!--
  Text that is in the element tree but never drawn. A control with no words of its own, a switch or
  a dropdown's button, carries one so the test harness, which finds elements by their text, can
  press it.
-->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";

  let { text }: { text: string } = $props();
</script>

<Text style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}>{text}</Text>
