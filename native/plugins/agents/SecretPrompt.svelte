<!--
  A secret the daemon asks for, such as an API key typed for /login: a masked field in place of the
  composer. The value goes to the daemon in the answer and is kept nowhere else: not in the draft,
  not in the history, not in the chat. Enter answers, Esc gives up. Ported from neo term's secret
  field (apps/term secret.rs).
-->
<script lang="ts">
  import { Input, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { SecretRequest } from "@suite/protocol/types";
  import { palette } from "./palette";

  interface Props {
    request: SecretRequest;
    /** The user answered with a value, or with nothing to give up. */
    onanswer: (value: string | undefined) => void;
  }

  let { request, onanswer }: Props = $props();

  const p = palette;

  let value = $state("");
  let input: ReturnType<typeof Input> | undefined = $state();

  // The field has the keyboard from the moment the question is asked.
  $effect(() => {
    input?.focus();
  });

  /** Enter answers with what was typed (an empty field gives up), Esc gives up. */
  function key(event: KeyEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      if (value === "") {
        onanswer(undefined);
        return;
      }
      onanswer(value);
      value = "";
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      value = "";
      onanswer(undefined);
    }
  }
</script>

<View style={{ paddingX: p.space.l, paddingY: p.space.m, gap: p.space.s }}>
  <View
    style={{ gap: p.space.s, padding: p.space.m, radius: 8, borderWidth: 1, borderColor: p.accent, background: p.elevated }}
  >
    <Text style={{ fontWeight: "bold" }}>{request.title}</Text>
    <Input
      bind:this={input}
      bind:value
      secure
      placeholder={request.placeholder}
      style={{ color: p.fg }}
      onkey={key}
    />
    <Text style={{ color: p.muted, fontSize: p.text.code }}>Enter sends it to the daemon, Esc gives up. It is kept nowhere else.</Text>
  </View>
</View>
