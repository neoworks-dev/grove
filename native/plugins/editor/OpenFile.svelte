<!--
  A field for a path to open, over the window. Enter opens the path in the focused pane and
  Escape closes the field. Kept minimal until the explorer is the usual way to open files.
-->
<script lang="ts">
  import { Input, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, overlayPanel, radius } from "../theme/tokens";
  import type { EditorService } from "./service";

  let { service }: { service: EditorService } = $props();

  const open = $derived(service.prompt()?.kind === "open-file");

  let path = $state("");
  let field = $state<ReturnType<typeof Input>>();

  // A fresh field each time it opens, with the keyboard in it.
  $effect(() => {
    if (!open) {
      return;
    }
    path = "";
    field?.focus();
  });

  /** Escape closes the field. */
  function closeOnEscape(event: { key: string }): void {
    if (event.key === "Escape") {
      service.cancelPrompt();
    }
  }
</script>

{#if open}
  <View
    style={{ position: "absolute", inset: 0, align: "center", background: "#00000066", paddingTop: 96 }}
    onpress={() => service.cancelPrompt()}
  >
    <View style={{ ...overlayPanel, width: 520, padding: 12, gap: 8 }} onpress={() => {}}>
      <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>Open file</Text>
      <Input
        bind:this={field}
        bind:value={path}
        placeholder="/path/to/file"
        style={{ paddingX: 10, paddingY: 6, radius: radius.md, background: colors.input, borderWidth: 1, borderColor: colors.line, fontSize: fontSize.sm }}
        focus={{ borderColor: colors.blue }}
        onkey={closeOnEscape}
        onsubmit={(text) => service.submitOpenFile(text)}
      />
    </View>
  </View>
{/if}
