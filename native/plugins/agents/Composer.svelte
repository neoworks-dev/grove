<script lang="ts">
  // Where the user types: a multiline field in a band under the chat, or, once the agent asks a
  // question (a permission or a choice) and the user has paused typing, the panel that answers it.
  // Enter sends, Ctrl-Enter stops a running turn and sends, Shift-Enter and Alt-Enter break the line, Up and Down walk what was sent, `/`
  // opens the command menu, Shift-Tab changes the approvals mode and Esc cancels the turn that is
  // running. The field has the keyboard while its pane is the focused one.
  import { untrack } from "svelte";
  import { clipboard } from "@neoworks/svelte-gpui";
  import { Input, Overlay, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent, Layout } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import CommandMenu from "./CommandMenu.svelte";
  import { ComposerModel } from "./composerModel";
  import ComposerControls from "./ComposerControls.svelte";
  import { createHistoryStore } from "./historyStore";
  import { palette } from "./palette";
  import PromptPanel from "./PromptPanel.svelte";

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

  // The composer belongs to the session its pane shows: another session gets a new Composer.
  const model = new ComposerModel(
    untrack(() => session),
    {
      history: createHistoryStore(),
      copyToClipboard: (text) => void clipboard.write(text),
    },
  );

  let input: ReturnType<typeof Input> | undefined = $state();
  let scroller: ReturnType<typeof Scroll> | undefined = $state();
  let width = $state(0);
  /** How many characters fit a row, roughly; the input does not say where its cursor is. */
  const columns = $derived(Math.floor(width / (p.text.body * 0.6)));

  const error = $derived(session.error());
  const prompt = $derived(model.prompt());
  const promptRef = $derived(prompt?.ref);
  const showPanel = $derived(model.engaged());
  const menuVisible = $derived(model.menuVisible());
  const notice = $derived(model.notice());

  // What was sent in this session before is what Up walks back through.
  $effect(() => {
    void model.loadHistory();
    return () => model.dispose();
  });

  // A question takes the input's place once the user has paused typing.
  $effect(() => {
    const wait = model.syncEngaged();
    if (wait === undefined) {
      return;
    }
    const timer = setTimeout(() => model.syncEngaged(), wait);
    return () => clearTimeout(timer);
  });

  // A new question starts on its current button, before it is drawn.
  $effect.pre(() => {
    void promptRef;
    untrack(() => model.startPrompt(model.prompt()));
  });

  // The chat draws a one-line stub for the question the panel is answering.
  $effect(() => {
    if (!showPanel || promptRef === undefined) {
      return;
    }
    session.setAnswering(promptRef);
    return () => session.setAnswering(undefined);
  });

  // The pane that has the focus has the keyboard in its field, unless a question has it.
  $effect(() => {
    if (focused && !showPanel && input) {
      input.focus();
    }
  });

  /** Puts the keyboard back in the field, as when the list of agents hands it over. */
  export function focus(): void {
    input?.focus();
  }

  /** Up and Down move the menu's highlight while it is open, else walk the history. */
  function arrow(event: KeyEvent): void {
    const older = event.key === "ArrowUp";
    if (model.menuVisible()) {
      model.moveMenu(older ? -1 : 1);
    } else {
      let direction: "older" | "newer" = "newer";
      if (older) {
        direction = "older";
      }
      if (!model.walkHistory(direction, columns, event.alt)) {
        return;
      }
    }
    event.preventDefault();
  }

  /** Enter sends, Tab completes a command, Up and Down walk, Shift-Tab changes approvals, Esc closes or cancels. */
  function key(event: KeyEvent): void {
    const plain = !event.ctrl && !event.alt && !event.meta;
    if (event.key === "Enter") {
      if (event.alt || event.shift) {
        return;
      }
      event.preventDefault();
      if (event.ctrl && running) {
        void sendNow();
        return;
      }
      model.submit();
      return;
    }
    if (event.key === "Tab" && event.shift) {
      event.preventDefault();
      void session.cycleApprovals();
      return;
    }
    if (event.key === "Tab" && model.menuVisible()) {
      event.preventDefault();
      model.complete();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && (plain || event.alt)) {
      arrow(event);
      return;
    }
    if (event.key === "Escape") {
      escape(event);
    }
  }

  /** Stops the turn that is running and sends what was typed, which would otherwise wait behind it. */
  async function sendNow(): Promise<void> {
    await session.cancel();
    model.submit();
  }

  /** Esc closes the menu or a question first; with nothing open it cancels the running turn. */
  function escape(event: KeyEvent): void {
    if (model.escape()) {
      event.preventDefault();
      return;
    }
    if (running) {
      event.preventDefault();
      void session.cancel();
    }
  }

  function layout(box: Layout): void {
    width = box.width;
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
  {#if showPanel}
    <PromptPanel {model} oncycle={() => void session.cycleApprovals()} />
  {:else}
    {#if model.waiting() && prompt !== undefined}
      <Text style={{ color: p.muted, truncate: true }}>
        {prompt.title || "A question"} is waiting. Stop typing to answer it, Esc puts it aside.
      </Text>
    {/if}
    <View
      style={{ direction: "row", gap: p.space.m, padding: p.space.m, radius: 6, borderWidth: 1, borderColor: p.border, background: p.bg }}
      onpress={() => input?.focus()}
    >
      <Text style={{ color: p.accent, lineHeight: LINE_HEIGHT, fontWeight: 600 }}>›</Text>
      <View style={{ flex: 1, minWidth: 0 }} onlayout={layout}>
        <Scroll bind:this={scroller} style={{ maxHeight: MAX_INPUT_HEIGHT }}>
          <View onlayout={grown}>
            <Input
              bind:this={input}
              bind:value={model.text}
              multiline
              rows={1}
              placeholder={running ? "The agent is working. Esc cancels the turn." : "Message the agent ( / commands · ↑↓ history )"}
              style={{ color: p.fg, lineHeight: LINE_HEIGHT }}
              oninput={() => model.typed()}
              onkey={key}
            />
          </View>
        </Scroll>
        {#if menuVisible}
          <Overlay side="top" align="start" offset={p.space.m} matchWidth>
            <CommandMenu {model} onchosen={() => input?.focus()} />
          </Overlay>
        {/if}
      </View>
    </View>
  {/if}
  <ComposerControls {session} {notice} />
</View>
