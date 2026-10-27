<script lang="ts">
  // A tool call on one line: a caret, the tool's word, and the argument that matters (a file
  // name, a command, a search). A call that changed a file shows the changed lines under it. The
  // result opens when the line is pressed, and is open from the start when it is a neoui doc.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { DiffComponent, ViewItem } from "@suite/protocol/types";
  import type { CallFacts } from "../calls";
  import { palette } from "../palette";
  import { argumentOf } from "./callRow";
  import { hasDoc } from "./components";
  import Component from "./Component.svelte";
  import { useChat } from "./context";
  import { diffStats } from "./diff";
  import DiffPreview from "./DiffPreview.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import Spinner from "./Spinner.svelte";
  import Summary from "./Summary.svelte";
  import { diffsIn, toolWord } from "./turns";
  import { chatView } from "./viewState";

  let { item, call }: { item: ViewItem; call: CallFacts } = $props();

  const p = palette;
  const chat = useChat();
  /** Rows the label of a call that has run is cut to; a running call stays on one. */
  const LABEL_ROWS = 2;

  const open = $derived(chatView.expanded || chatView.isOpened(item.ref) || hasDoc(item.component));
  const argument = $derived(argumentOf(call));
  const diffs = $derived(diffsIn(item.component));
  const added = $derived(diffs.reduce((sum, diff) => sum + diffStats(diff.lines).added, 0));
  const removed = $derived(diffs.reduce((sum, diff) => sum + diffStats(diff.lines).removed, 0));
  const failed = $derived(item.state === "failed");
  const running = $derived(item.state === "running");

  const wordColor = $derived.by(() => {
    if (failed) {
      return p.danger;
    }
    if (running) {
      return p.accent;
    }
    return p.muted;
  });

  /** Shows a change in a diff pane, from the two texts the call reported. */
  function showDiff(diff: DiffComponent): void {
    const path = diff.path ?? "";
    const change = call.diffs.find((entry) => entry.path === path);
    if (change === undefined) {
      chat.openDiff(path);
      return;
    }
    chat.openDiffBetween(path, { oldText: change.oldText === undefined ? "" : change.oldText, newText: change.newText });
  }

  /** The full command of a call that ran one, for when the row is open. */
  const command = $derived.by(() => {
    const input = call.rawInput;
    if (typeof input !== "object" || input === null) {
      return undefined;
    }
    const value = (input as Record<string, unknown>).command;
    if (typeof value === "string") {
      return value;
    }
    return undefined;
  });
</script>

<ItemFrame>
  <View style={{ paddingX: p.space.l, gap: 2 }}>
    <View style={{ direction: "row", align: "center", gap: p.space.m }}>
      <View
        onpress={() => chatView.toggleOpened(item.ref)}
        style={{ direction: "row", align: "center", gap: p.space.m, shrink: 0, cursor: "pointer" }}
      >
        <Text style={{ width: 10, color: p.muted, fontFamily: "mono", fontSize: p.text.code }}>{open ? "⌄" : "›"}</Text>
        {#if running}
          <View style={{ color: p.accent }}><Spinner /></View>
        {:else}
          <Text style={{ color: failed ? p.danger : p.success, fontSize: p.text.code, shrink: 0 }}>●</Text>
        {/if}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, fontWeight: "bold", color: wordColor }}>{toolWord(call)}</Text>
      </View>
      {#if argument.path !== undefined}
        <View
          onpress={() => chat.openFile(argument.path ?? "")}
          style={{ direction: "row", gap: p.space.m, flex: 1, minWidth: 0, cursor: "pointer" }}
        >
          <Text style={{ fontFamily: "mono", fontSize: p.text.code, shrink: 0 }}>{argument.text}</Text>
          {#if argument.directory !== undefined}
            <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, flex: 1, minWidth: 0, truncate: true }}>{argument.directory}</Text>
          {/if}
        </View>
      {:else}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted, flex: 1, minWidth: 0, maxLines: running ? undefined : LABEL_ROWS, truncate: running }}>{argument.text}</Text>
      {/if}
      {#if added > 0}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.success, shrink: 0 }}>+{added}</Text>
      {/if}
      {#if removed > 0}
        <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.danger, shrink: 0 }}>−{removed}</Text>
      {/if}
    </View>
    {#if open}
      <View style={{ paddingLeft: 20, gap: p.space.s }}>
        {#if command !== undefined}
          <Text pre style={{ fontFamily: "mono", fontSize: p.text.code, color: p.muted }}>{command}</Text>
        {/if}
        <Component component={item.component} ref={item.ref} />
      </View>
    {:else if diffs.length > 0}
      <View style={{ paddingLeft: 20, gap: 2 }}>
        {#each diffs as diff}
          <DiffPreview {diff} onpress={() => showDiff(diff)} />
        {/each}
      </View>
    {:else if failed}
      <View style={{ paddingLeft: 20, color: p.muted }}>
        <Summary component={item.component} ref={item.ref} />
      </View>
    {/if}
  </View>
</ItemFrame>
