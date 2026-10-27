<script lang="ts">
  // Where the user types: a multiline field in a band under the chat, or, once the agent asks a
  // question (a permission or a choice) and the user has paused typing, the panel that answers it.
  // Enter sends, Ctrl-Enter stops a running turn and sends, Shift-Enter and Alt-Enter break the line, Up and Down walk what was sent, `/`
  // opens the command menu, Shift-Tab changes the approvals mode and Esc cancels the turn that is
  // running. The field has the keyboard while its pane is the focused one.
  import { untrack } from "svelte";
  import { clipboard } from "@neoworks/svelte-gpui";
  import { Button, Icon, Input, Overlay, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import gauge from "@phosphor-icons/core/regular/gauge.svg";
  import arrowUp from "@phosphor-icons/core/regular/arrow-up.svg";
  import stopIcon from "@phosphor-icons/core/regular/stop.svg";
  import type { KeyEvent, Layout } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import AttachedImages from "./AttachedImages.svelte";
  import { createClipboardAccess } from "./clipboardAccess";
  import CommandMenu from "./CommandMenu.svelte";
  import MentionMenu from "./MentionMenu.svelte";
  import type { Candidate } from "./mention";
  import { ComposerModel } from "./composerModel";
  import ComposerControls from "./ComposerControls.svelte";
  import { approvalsChoices, approvalsIcon, harnessChoices, harnessLabel, modeLine, optionChoices, optionLabel } from "./composerControls";
  import HarnessIcon from "./HarnessIcon.svelte";
  import { currentSettings } from "./status";
  import ControlSelect from "./ControlSelect.svelte";
  import { createHistoryStore } from "./historyStore";
  import { palette } from "./palette";
  import PromptPanel from "./PromptPanel.svelte";
  import QueuedMessages from "./QueuedMessages.svelte";

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
  /** Model names run long (`openrouter/deepseek/deepseek-v4.1-flash`), so their list is wider than the others. */
  const MODEL_LIST_WIDTH = 360;

  // The composer belongs to the session its pane shows: another session gets a new Composer.
  const model = new ComposerModel(
    untrack(() => session),
    {
      history: createHistoryStore(),
      copyToClipboard: (text) => void clipboard.write(text),
      clipboard: createClipboardAccess(),
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
  const mentionVisible = $derived(model.mentionVisible());
  const notice = $derived(model.notice());
  const waiting = $derived(session.waiting());
  const status = $derived(session.status());
  const approvals = $derived(status.approvals);
  const harness = $derived(session.harness());
  const settings = $derived(currentSettings({ ...status, harness }));
  const offered = $derived(session.offered());
  const modelLabel = $derived(optionLabel(offered, harness, "model", settings.model));
  const effortLabel = $derived(optionLabel(offered, harness, "thought_level", settings.effort));
  const efforts = $derived(optionChoices(offered, harness, "thought_level"));
  const attachments = $derived(model.attachments());
  const empty = $derived(model.text.trim() === "" && attachments.length === 0);

  // What was sent in this session before is what Up walks back through.
  $effect(() => {
    void model.loadHistory();
    return () => model.dispose();
  });

  // While a question about an edit waits, the edit shows as a diff in the editor; answering it,
  // or putting it aside, takes the diff away. Opening is untracked, so the panes it touches do
  // not open it again.
  const editQuestion = $derived(model.editQuestion());
  $effect(() => {
    const question = editQuestion;
    if (question === undefined) {
      return;
    }
    untrack(() => model.showEdit(question));
    return () => model.hideEdit();
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
    if (older && model.text.trim() === "" && session.waiting().length > 0) {
      event.preventDefault();
      // Messages another app queued are not ours to take back: then Up walks the history as usual.
      void model.takeBackWaiting().then((took) => {
        if (!took) {
          model.walkHistory("older", columns, event.alt);
        }
      });
      return;
    }
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
    if (model.mentionVisible() && plain && !event.shift && mentionKey(event)) {
      return;
    }
    if (event.ctrl && !event.alt && !event.meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      model.swapStash();
      return;
    }
    if (event.ctrl && !event.alt && !event.meta && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void paste();
      return;
    }
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

  /** Up and Down move the `@` list, Tab and Enter put the highlighted file in the draft. Returns whether the key was used. */
  function mentionKey(event: KeyEvent): boolean {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      model.moveMention(event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Tab" || event.key === "Enter") {
      acceptMention();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  /** Ctrl+V: an image on the clipboard is attached; any other text is pasted at the cursor. */
  async function paste(): Promise<void> {
    const selection = input?.getSelection();
    const text = await model.paste();
    if (text === undefined || text === "") {
      return;
    }
    let start = model.text.length;
    let end = start;
    if (selection !== null && selection !== undefined) {
      start = Math.min(selection.start, selection.end);
      end = Math.max(selection.start, selection.end);
    }
    const cursor = model.insertText(text, start, end);
    setTimeout(() => input?.select(cursor, cursor), 0);
  }

  /** Puts a file of the `@` list in the draft, and the cursor after it. */
  function acceptMention(candidate?: Candidate): void {
    const cursor = model.acceptMention(candidate);
    if (cursor === undefined) {
      return;
    }
    input?.focus();
    // The field takes the new text before it can place the cursor in it.
    setTimeout(() => input?.select(cursor, cursor), 0);
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

  /** Asks the daemon to switch the approvals mode. */
  function setApprovals(value: string): void {
    void session.send(`/approvals ${value}`);
  }

  /** The small round send and stop button, in the given fill and icon colour. */
  function roundButton(background: string, color: string) {
    return { width: 24, height: 24, radius: 12, align: "center", justify: "center", background, color } as const;
  }

  /** The send button: a neutral fill while there is nothing to send, the accent once there is. */
  function sendButton(nothingToSend: boolean) {
    if (nothingToSend) {
      return roundButton(p.band, p.muted);
    }
    return roundButton(p.accent, p.bg);
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

<View style={{ paddingX: p.space.l, paddingY: p.space.m, gap: p.space.s }}>
  {#if error !== null}
    <View style={{ direction: "row", gap: p.space.m }} onpress={() => session.clearError()}>
      <Text style={{ flex: 1, minWidth: 0, color: p.danger }}>{error}</Text>
      <Text style={{ color: p.muted }}>dismiss</Text>
    </View>
  {/if}
  {#if showPanel}
    <PromptPanel {model} paneFocused={focused} oncycle={() => void session.cycleApprovals()} />
  {:else}
    {#if model.waiting() && prompt !== undefined}
      <Text style={{ color: p.muted, truncate: true }}>
        {prompt.title || "A question"} is waiting. Stop typing to answer it, Esc puts it aside.
      </Text>
    {/if}
    {#if waiting.length > 0}
      <QueuedMessages {waiting} />
    {/if}
    {#if attachments.length > 0}
      <AttachedImages {attachments} ondetach={(id) => model.detach(id)} />
    {/if}
    <View
      style={{ gap: p.space.s, padding: p.space.m, radius: 8, borderWidth: 1, borderColor: p.elevatedBorder, background: p.elevated }}
      onpress={() => input?.focus()}
      ondrop={(drop) => model.dropped(drop.paths)}
    >
      <View style={{ minWidth: 0, paddingX: p.space.s }} onlayout={layout}>
        <Scroll bind:this={scroller} style={{ maxHeight: MAX_INPUT_HEIGHT }}>
          <View onlayout={grown}>
            <Input
              bind:this={input}
              bind:value={model.text}
              multiline
              rows={2}
              placeholder={running ? "The marmot is working. Esc cancels the turn." : "What are we doing today?"}
              style={{ color: p.fg, lineHeight: LINE_HEIGHT }}
              oninput={() => model.typed()}
              onselect={(selection) => model.moved(selection.end)}
              onkey={key}
            />
          </View>
        </Scroll>
        {#if mentionVisible}
          <Overlay side="top" align="start" offset={p.space.m} matchWidth>
            <MentionMenu {model} onchosen={acceptMention} />
          </Overlay>
        {:else if menuVisible}
          <Overlay side="top" align="start" offset={p.space.m} matchWidth>
            <CommandMenu {model} onchosen={() => input?.focus()} />
          </Overlay>
        {/if}
      </View>
      <View style={{ direction: "row", align: "center", gap: p.space.s }}>
          <ControlSelect
            value={harness}
            options={harnessChoices(offered, harness)}
            shown={harnessLabel(offered, harness)}
            onopen={() => void session.loadOffered()}
            onchange={(name) => void session.setHarness(name)}
          >
            {#snippet icon()}<HarnessIcon harness={harness} size={12} />{/snippet}
          </ControlSelect>
          <ControlSelect
            value={settings.model ?? ""}
            options={optionChoices(offered, harness, "model")}
            shown={modelLabel ?? "Model"}
            width={MODEL_LIST_WIDTH}
            onopen={() => void session.loadOffered()}
            onchange={(value) => void session.setOption("model", value)}
          />
          <ControlSelect value={approvals} options={approvalsChoices()} shown={modeLine(approvals)} onchange={setApprovals}>
            {#snippet icon()}<Icon svg={approvalsIcon(approvals)} size={12} />{/snippet}
          </ControlSelect>
        <View style={{ flex: 1, minWidth: 0 }} />
        {#if (efforts.length > 0 || effortLabel !== undefined)}
          <ControlSelect
            value={settings.effort ?? ""}
            options={efforts}
            shown={effortLabel ?? "Effort"}
            onopen={() => void session.loadOffered()}
            onchange={(value) => void session.setOption("effort", value)}
          >
            {#snippet icon()}<Icon svg={gauge} size={12} />{/snippet}
          </ControlSelect>
        {/if}
        {#if running}
          <Button onpress={() => void session.cancel()} style={roundButton(p.band, p.fg)} hover={{ background: p.border }}>
            <Icon svg={stopIcon} size={12} />
          </Button>
        {:else}
          <Button onpress={() => model.submit()} style={sendButton(empty)} hover={{ background: empty ? p.border : p.accent }}>
            <Icon svg={arrowUp} size={12} />
          </Button>
        {/if}
      </View>
    </View>
  {/if}
  <ComposerControls {session} {notice} stashed={model.hasStash()} />
</View>
