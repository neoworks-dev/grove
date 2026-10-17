<script lang="ts">
  // Where the user types: a multiline field in a band under the chat. Enter sends, Shift-Enter
  // and Alt-Enter break the line, and Esc cancels the turn that is running. The field has the
  // keyboard while its pane is the focused one.
  import { Input, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent, Layout } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import { palette } from "./palette";

  interface Props {
    session: ChatSession;
    /** A turn is running, so Esc has something to cancel. */
    running: boolean;
    /** The pane this is drawn in has the focus. */
    focused: boolean;
  }

  let { session, running, focused }: Props = $props();

  const p = palette;

  /** The field grows with its text up to this many pixels, then scrolls. */
  const MAX_INPUT_HEIGHT = 200;
  const LINE_HEIGHT = 20;

  let input: ReturnType<typeof Input> | undefined = $state();
  let scroller: ReturnType<typeof Scroll> | undefined = $state();
  let text = $state("");
  const error = $derived(session.error());

  // The pane that has the focus has the keyboard in its field.
  $effect(() => {
    if (focused && input) {
      input.focus();
    }
  });

  /** Sends the draft, if it holds anything, and clears it. */
  function submit(): void {
    const draft = text.trim();
    if (draft === "") {
      return;
    }
    text = "";
    void session.send(draft);
  }

  /** Enter sends and Esc cancels the running turn; every other key is the field's. */
  function key(event: KeyEvent): void {
    if (event.key === "Enter") {
      if (event.alt || event.shift) {
        return;
      }
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && running) {
      event.preventDefault();
      void session.cancel();
    }
  }

  /** Follows the end of the text while it grows past the cap. */
  function grown(box: Layout): void {
    if (box.height > MAX_INPUT_HEIGHT) {
      scroller?.scrollTo(box.height);
    }
  }
</script>

<View style={{ background: p.band, paddingX: p.space.l, paddingY: p.space.m, gap: p.space.s }}>
  {#if error !== null}
    <View style={{ direction: "row", gap: p.space.m }} onpress={() => session.clearError()}>
      <Text style={{ flex: 1, minWidth: 0, color: p.danger }}>{error}</Text>
      <Text style={{ color: p.muted }}>dismiss</Text>
    </View>
  {/if}
  <View style={{ direction: "row", gap: p.space.m }} onpress={() => input?.focus()}>
    <Text style={{ color: p.accent, lineHeight: LINE_HEIGHT, fontWeight: 600 }}>›</Text>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Scroll bind:this={scroller} style={{ maxHeight: MAX_INPUT_HEIGHT }}>
        <View onlayout={grown}>
          <Input
            bind:this={input}
            bind:value={text}
            multiline
            rows={1}
            placeholder={running ? "The agent is working. Esc cancels the turn." : "Message the agent"}
            style={{ color: p.fg, lineHeight: LINE_HEIGHT }}
            onkey={key}
          />
        </View>
      </Scroll>
    </View>
  </View>
</View>
