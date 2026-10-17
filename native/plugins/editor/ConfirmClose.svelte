<!--
  Asks what to do with a document that has unsaved changes when its last tab closes: save it,
  throw the changes away, or keep it open. An overlay over the whole window; it draws only
  while the editor service has such a question open.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { EditorService } from "./service";

  let { service }: { service: EditorService } = $props();

  const prompt = $derived(service.prompt());
  const question = $derived.by(() => {
    if (prompt && prompt.kind === "confirm-close") {
      return prompt;
    }
    return null;
  });

  const choice = {
    paddingX: 12,
    paddingY: 6,
    radius: radius.md,
    fontSize: fontSize.xs,
    background: colors.hover,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.line,
  } as const;
</script>

{#if question}
  <View
    style={{ position: "absolute", inset: 0, align: "center", justify: "center", background: "#000000aa" }}
    onpress={() => service.answerConfirmClose("cancel")}
  >
    <View
      style={{ width: 400, padding: 20, gap: 16, radius: radius.lg, background: colors.elevated, borderWidth: 1, borderColor: colors.lineStrong }}
      onpress={() => {}}
    >
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 15, fontWeight: "semibold", color: colors.text }}>Save changes to {question.title}?</Text>
        <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>Your changes are lost if you do not save them.</Text>
      </View>
      <View style={{ direction: "row", justify: "end", gap: 8 }}>
        <Button style={choice} hover={{ background: colors.raised }} onpress={() => service.answerConfirmClose("cancel")}>
          <Text>Cancel</Text>
        </Button>
        <Button style={choice} hover={{ background: colors.raised }} onpress={() => service.answerConfirmClose("discard")}>
          <Text>Don't save</Text>
        </Button>
        <Button
          style={{ ...choice, background: colors.blue, borderColor: colors.blue, color: colors.canvas }}
          hover={{ background: "#93c5fd" }}
          onpress={() => service.answerConfirmClose("save")}
        >
          <Text>Save</Text>
        </Button>
      </View>
    </View>
  </View>
{/if}
